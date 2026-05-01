const crypto = require("node:crypto");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { graphGetBuffer } = require("../lib/graph-client");
const {
  buildStoragePath,
  safeFileName,
  slugify,
  uploadDriveItem,
} = require("./sharepoint.service");
const { coerceSettings } = require("./workspace-automation.service");
const {
  normalizeAiExtractionSchema,
} = require("./document-extraction.service");
const { createAuditEvent } = require("./audit.service");

async function listDocuments(userId, workspaceId, query = {}) {
  const take = Math.min(200, Math.max(1, Number(query.take || 50)));
  const status = query.status ? String(query.status) : null;
  const typeKey = query.type ? String(query.type) : null;
  const q = query.q ? String(query.q).trim() : "";

  return prisma.documentRecord.findMany({
    where: {
      userId,
      workspaceId,
      ...(status ? { status } : {}),
      ...(typeKey
        ? {
            documentType: {
              key: typeKey,
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { fileName: { contains: q, mode: "insensitive" } },
              { lastError: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      documentType: {
        select: { id: true, key: true, displayName: true, aiExtractionSchema: true },
      },
      emailMessage: { select: { id: true, subject: true, sender: true, receivedAt: true } },
    },
  });
}

async function getDocument(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, userId, workspaceId },
    include: {
      documentType: true,
      emailMessage: true,
      approvalRequests: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  return doc;
}

/**
 * Descarga el binario del adjunto vía Microsoft Graph (item en drive).
 * Requiere que el documento ya esté vinculado a SharePoint.
 *
 * @returns {{ buffer: Buffer, contentType: string, fileName: string }}
 */
async function getDocumentFileBuffer(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, userId, workspaceId },
    include: {
      workspace: { select: { aadTenantId: true } },
    },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  if (!doc.sharepointDriveId || !doc.sharepointItemId) {
    throw new HttpError(
      404,
      "El archivo aún no está disponible para descarga (falta referencia de SharePoint)."
    );
  }
  const tenantId = doc.workspace?.aadTenantId;
  if (!tenantId) {
    throw new HttpError(500, "Workspace sin tenant de Azure AD");
  }
  const path = `/drives/${encodeURIComponent(doc.sharepointDriveId)}/items/${encodeURIComponent(
    doc.sharepointItemId
  )}/content`;
  try {
    const buffer = await graphGetBuffer(path, { tenantId });
    return {
      buffer,
      contentType: doc.contentType || "application/octet-stream",
      fileName: doc.fileName || "documento",
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      "No se pudo descargar el archivo desde Microsoft Graph",
      err?.message ? String(err.message) : undefined
    );
  }
}

/**
 * Devuelve el layout OCR (Azure Document Intelligence) asociado al documento.
 * Forma compacta lista para alimentar al visor del frontend.
 *
 * @returns {Promise<{
 *   modelId: string,
 *   apiVersion: string,
 *   pageCount: number,
 *   pages: unknown,
 *   tables: unknown,
 * }>}
 */
async function getDocumentLayout(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, userId, workspaceId },
    select: { id: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  const layout = await prisma.documentLayout.findUnique({
    where: { documentId: id },
    select: {
      modelId: true,
      apiVersion: true,
      pageCount: true,
      pages: true,
      tables: true,
      createdAt: true,
    },
  });
  if (!layout) {
    throw new HttpError(
      404,
      "Aún no hay layout OCR para este documento (procesamiento pendiente o Azure DI no configurado)."
    );
  }
  return layout;
}

/**
 * Sube (o re-sube) un `DocumentRecord` a SharePoint usando los datos ya
 * extraídos. Útil cuando el documento se procesó antes de tener la integración
 * configurada o falló su archivado.
 *
 * Flujo:
 *  1. Carga el documento con su workspace, email y tipo.
 *  2. Resuelve la integración SP del workspace y verifica `configJson.driveId`.
 *  3. Recupera el binario del adjunto desde el email original (Microsoft Graph),
 *     buscando el `fileAttachment` cuyo SHA-256 matchea al guardado.
 *  4. Construye la ruta destino con `buildStoragePath` aplicando el routing del
 *     tipo o el del workspace, usando los valores ya extraídos en `extractionJson`.
 *  5. Sube el archivo y persiste las referencias SharePoint.
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Promise<{ document: import("@prisma/client").DocumentRecord, sharepointPath: string, webUrl: string | null }>}
 */
async function archiveDocumentToSharePoint(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, userId, workspaceId },
    include: {
      documentType: true,
      emailMessage: { include: { integration: true } },
      workspace: { select: { id: true, aadTenantId: true, automationSettings: true } },
    },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  if (!doc.workspace) throw new HttpError(500, "Workspace asociado no encontrado");
  if (!doc.documentTypeId || !doc.documentType) {
    throw new HttpError(409, "El documento todavía no tiene un tipo asignado; clasificalo primero.");
  }
  if (!doc.sha256) {
    throw new HttpError(409, "El documento no tiene SHA-256 registrado (no se puede localizar el adjunto).");
  }

  const settings = coerceSettings(doc.workspace.automationSettings);
  const spIntegrationId = settings.sharepointIntegrationId;
  if (!spIntegrationId) {
    throw new HttpError(
      409,
      "El workspace no tiene una integración SharePoint configurada en automatización."
    );
  }

  const sp = await prisma.integrationConnection.findFirst({
    where: { id: spIntegrationId, workspaceId, kind: "sharepoint" },
  });
  if (!sp) {
    throw new HttpError(404, "Integración SharePoint no encontrada en este workspace.");
  }
  const cfg = sp.configJson && typeof sp.configJson === "object" ? sp.configJson : {};
  if (!cfg.driveId) {
    throw new HttpError(
      409,
      "La integración SharePoint no tiene `driveId` configurado; volvé a conectar el sitio."
    );
  }

  const email = doc.emailMessage;
  if (!email || !email.integration || !email.externalId) {
    throw new HttpError(
      409,
      "No se puede recuperar el adjunto: el correo origen no tiene integración o externalId."
    );
  }
  const mailbox = email.integration?.configJson?.mailbox;
  if (!mailbox) {
    throw new HttpError(409, "La integración de correo no tiene `mailbox` configurado.");
  }

  // Lazy require para evitar ciclo de módulos.
  const { loadMessageAttachments } = require("./email-automation.service");
  const loaded = await loadMessageAttachments(
    doc.workspace.aadTenantId,
    mailbox,
    email.externalId
  );
  const matching = (loaded.pdfAttachments || []).find(
    (a) => crypto.createHash("sha256").update(a.buffer).digest("hex") === doc.sha256
  );
  if (!matching?.buffer) {
    throw new HttpError(
      404,
      "No se encontró el adjunto original en el correo (¿se eliminó o cambió?)."
    );
  }

  const typeKey = doc.documentType.key || "documento";
  const isInvoice = typeKey === "invoice";

  const extraction =
    doc.extractionJson && typeof doc.extractionJson === "object" ? doc.extractionJson : {};
  const schemaNorm = normalizeAiExtractionSchema(doc.documentType.aiExtractionSchema);
  const extractionFields = {};
  if (schemaNorm.fields.length > 0) {
    const fieldsObj =
      extraction.fields && typeof extraction.fields === "object" ? extraction.fields : null;
    for (const f of schemaNorm.fields) {
      const rich = fieldsObj ? fieldsObj[f.key] : undefined;
      if (rich && typeof rich === "object" && Object.prototype.hasOwnProperty.call(rich, "value")) {
        extractionFields[f.key] = rich.value;
      } else if (Object.prototype.hasOwnProperty.call(extraction, f.key)) {
        extractionFields[f.key] = extraction[f.key];
      }
    }
  }

  const routing =
    doc.documentType.sharepointRouting && typeof doc.documentType.sharepointRouting === "object"
      ? doc.documentType.sharepointRouting
      : {};
  const typeRoot =
    typeof routing.rootFolder === "string" && routing.rootFolder.trim()
      ? routing.rootFolder.trim()
      : settings.rootFolder;
  const typeTpl = routing.pathTemplate || doc.documentType.sharePointPathTemplate || null;

  const vendorName = isInvoice ? extraction.vendor_name || null : null;
  const country = isInvoice ? extraction.country || null : null;
  const area = isInvoice ? extraction.area || null : null;
  const invoiceNumber = isInvoice ? extraction.invoice_number || null : null;
  const invoiceDate =
    isInvoice && typeof extraction.invoice_date === "string" && extraction.invoice_date
      ? new Date(extraction.invoice_date)
      : null;

  const folder = buildStoragePath(
    typeTpl || settings.pathTemplate,
    {
      vendorName,
      country,
      area,
      invoiceNumber,
      receivedAt: email.receivedAt,
      invoiceDate,
      documentTypeKey: typeKey,
      extractionFields: Object.keys(extractionFields).length ? extractionFields : undefined,
    },
    typeRoot
  );
  const base = `${slugify(typeKey || "documento")}_${doc.sha256.slice(0, 10)}`;
  const relative = `${folder}/${safeFileName(base)}`;

  let uploaded;
  try {
    uploaded = await uploadDriveItem(
      doc.workspace.aadTenantId,
      cfg.driveId,
      relative,
      matching.buffer,
      matching.contentType
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.documentRecord.update({
      where: { id: doc.id },
      data: { lastError: `SharePoint: ${msg.slice(0, 600)}` },
    });
    await createAuditEvent({
      action: "document.archive_failed.sharepoint",
      userId,
      workspaceId,
      entityType: "DocumentRecord",
      entityId: doc.id,
      metadata: { error: msg.slice(0, 600), phase: "manual_retry" },
    });
    throw new HttpError(502, `No se pudo subir el archivo a SharePoint: ${msg.slice(0, 300)}`);
  }

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: {
      status: "ARCHIVED",
      sharepointSiteId: cfg.siteId || null,
      sharepointDriveId: cfg.driveId,
      sharepointItemId: uploaded?.id || null,
      sharepointWebUrl: uploaded?.webUrl || null,
      sharepointPath: relative,
      lastError: null,
    },
  });
  await createAuditEvent({
    action: "document.archived.sharepoint",
    userId,
    workspaceId,
    entityType: "DocumentRecord",
    entityId: doc.id,
    metadata: {
      sharepointPath: relative,
      webUrl: uploaded?.webUrl || null,
      phase: "manual_retry",
    },
  });

  return {
    document: updated,
    sharepointPath: relative,
    webUrl: uploaded?.webUrl || null,
  };
}

module.exports = {
  listDocuments,
  getDocument,
  getDocumentFileBuffer,
  getDocumentLayout,
  archiveDocumentToSharePoint,
};

