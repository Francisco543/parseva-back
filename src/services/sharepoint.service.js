const { graphRequest, graphPutContent } = require("../lib/graph-client");
const HttpError = require("../utils/http-error");

/**
 * @returns {{ hostname: string, sitePath: string, isTenantRoot: boolean }}
 */
function parseSiteUrl(siteUrl) {
  let u;
  try {
    u = new URL(siteUrl.trim());
  } catch {
    throw new HttpError(400, "URL de sitio SharePoint invalida");
  }

  const hostname = u.hostname.toLowerCase();
  if (!hostname) {
    throw new HttpError(400, "Host de SharePoint requerido");
  }

  const path = u.pathname.replace(/^\/+|\/+$/g, "");
  const isTenantRoot = !path;

  if (
    hostname.includes("-my.sharepoint.com") &&
    u.pathname.toLowerCase().includes("/personal/")
  ) {
    throw new HttpError(
      400,
      "Esa URL es de OneDrive personal. Usa la URL del sitio (ej. tu-tenant.sharepoint.com o .../sites/Nombre)"
    );
  }

  return { hostname, sitePath: path, isTenantRoot };
}

async function resolveSiteFromUrl(tenantId, siteUrl) {
  const { hostname, sitePath, isTenantRoot } = parseSiteUrl(siteUrl);

  let site;
  if (isTenantRoot) {
    site = await graphRequest("/sites/root", { method: "GET" }, { tenantId });
  } else {
    const graphPath = `/sites/${hostname}:/${sitePath}`;
    site = await graphRequest(graphPath, { method: "GET" }, { tenantId });
  }

  const drive = await graphRequest(
    `/sites/${site.id}/drive`,
    { method: "GET" },
    { tenantId }
  );

  return {
    siteId: site.id,
    siteDisplayName: site.displayName || site.name,
    webUrl: site.webUrl,
    driveId: drive.id,
    driveName: drive.name,
    driveWebUrl: drive.webUrl,
  };
}

function sanitizeSegment(name) {
  return String(name || "sin-nombre")
    .replace(/["*:<>?/\\|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function slugify(value) {
  const base = sanitizeSegment(value).normalize("NFD").replace(/\p{M}/gu, "");
  const slug = base
    .toLowerCase()
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "sin-dato";
}

function datePartsUtc(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) {
    const now = new Date();
    return {
      year: String(now.getUTCFullYear()),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
      day: String(now.getUTCDate()).padStart(2, "0"),
    };
  }
  return {
    year: String(x.getUTCFullYear()),
    month: String(x.getUTCMonth() + 1).padStart(2, "0"),
    day: String(x.getUTCDate()).padStart(2, "0"),
  };
}

/** Valores del JSON extraído por campo (esquema del tipo) → segmento de ruta */
function extractionFieldToSegment(value) {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return (value ? "si" : "no").slice(0, 80);
  if (typeof value === "number" && Number.isFinite(value)) return slugify(String(value));
  if (typeof value === "string") return slugify(value);
  if (Array.isArray(value)) return slugify(value.map((x) => String(x)).join("-"));
  if (typeof value === "object") {
    try {
      return slugify(JSON.stringify(value).slice(0, 120));
    } catch {
      return "dato";
    }
  }
  return slugify(String(value));
}

/**
 * Plantilla de carpetas: {year}/{month} usan la fecha de la FACTURA si existe; si no, la de recepción del correo.
 * {received_year}/{received_month}: siempre según el correo.
 */
function buildStoragePath(template, vars, rootFolder) {
  const received = vars.receivedAt ? new Date(vars.receivedAt) : new Date();
  const filingBase =
    vars.invoiceDate instanceof Date && !Number.isNaN(vars.invoiceDate.getTime())
      ? vars.invoiceDate
      : received;

  const { year: ry, month: rm, day: rd } = datePartsUtc(received);
  const { year: fy, month: fm, day: fd } = datePartsUtc(filingBase);

  const vendorName = vars.vendorName || "";
  const docTypeKey = String(vars.documentTypeKey || "").trim();
  const vendorSlug = slugify(vendorName);
  /** Alineado con la vista previa del front ({vendor_name} ~ acme_sa) */
  const vendorNameSlug = (vendorSlug || "sin-dato").replace(/-/g, "_");
  const map = {
    year: fy,
    month: fm,
    day: fd,
    received_year: ry,
    received_month: rm,
    received_day: rd,
    vendor: sanitizeSegment(vendorName || "Sin proveedor"),
    vendor_slug: vendorSlug,
    /** Mismo criterio que slug de proveedor, con guiones bajos (plantillas UI) */
    vendor_name: vendorNameSlug,
    doc_type: sanitizeSegment(docTypeKey || "documento"),
    doc_type_slug: slugify(docTypeKey || "documento"),
    country: slugify(vars.country || ""),
    area: slugify(vars.area || ""),
    invoice_number: slugify(vars.invoiceNumber || ""),
  };

  const extractionFields =
    vars.extractionFields && typeof vars.extractionFields === "object" ? vars.extractionFields : null;
  if (extractionFields) {
    for (const [k, v] of Object.entries(extractionFields)) {
      if (!/^\w+$/.test(k)) continue;
      map[k] = extractionFieldToSegment(v);
    }
  }

  let path = String(template || "/{year}/{month}/{vendor_slug}").replace(
    /\{(\w+)\}/g,
    (_, key) => map[key] ?? ""
  );
  path = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("/");
  path = path.replace(/\/+/g, "/").replace(/^\/+/g, "").replace(/\/+$/g, "");

  const root = String(rootFolder || "").replace(/^\/+|\/+$/g, "");
  if (root) {
    path = `${root}/${path}`;
  }
  return path.replace(/\/+/g, "/").replace(/\/+$/g, "");
}

function safeFileName(base) {
  const clean = sanitizeSegment(base).replace(/\s+/g, "-") || "factura";
  return clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
}

/**
 * Sube un archivo. Graph crea carpetas intermedias en rutas con /.
 * @param {string} relativePath - Sin leading slash, ej: 2025/acme/factura.pdf
 */
async function uploadDriveItem(tenantId, driveId, relativePath, buffer, contentType) {
  const normalized = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!normalized) throw new HttpError(400, "Ruta de archivo invalida");

  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const graphPath = `/drives/${driveId}/root:/${encoded}:/content`;
  return graphPutContent(graphPath, buffer, contentType || "application/octet-stream", {
    tenantId,
  });
}

module.exports = {
  resolveSiteFromUrl,
  parseSiteUrl,
  sanitizeSegment,
  slugify,
  buildStoragePath,
  safeFileName,
  uploadDriveItem,
};
