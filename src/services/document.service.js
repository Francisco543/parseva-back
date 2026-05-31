const crypto = require("node:crypto");
const { z } = require("zod");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const {
  buildStoragePath,
  safeFileName,
  slugify,
} = require("./sharepoint.service");
const { coerceSettings, getArchiveIntegrationId } = require("./workspace-automation.service");
const {
  archiveUploadFromIntegration,
  downloadArchivedDocumentBuffer,
  assertArchiveIntegration,
} = require("./document-archive-storage.service");
const { INTEGRATION_KIND } = require("../constants/integration");
const { AUDIT_ACTION } = require("../constants/audit-actions");
const {
  normalizeAiExtractionSchema,
} = require("./document-extraction.service");
const { createAuditEvent } = require("./audit.service");

function isTruthyQueryFlag(v) {
  return v === true || v === "1" || v === "true";
}

/**
 * Documentos aprobados cuyo tipo tiene BC en modo MANUAL con perfil — pendientes de envío explícito.
 *
 * @param {string} workspaceId
 * @param {number} take
 */
async function listDocumentsPendingBcManual(workspaceId, take) {
  const rows = await prisma.documentRecord.findMany({
    where: {
      workspaceId,
      status: "APPROVED",
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(200, Math.max(1, take)),
    include: {
      documentType: {
        select: {
          id: true,
          key: true,
          displayName: true,
          bcPolicy: true,
          aiExtractionSchema: true,
        },
      },
      emailMessage: { select: { id: true, subject: true, sender: true, receivedAt: true } },
    },
  });

  return rows.filter((doc) => {
    const bp = doc.documentType?.bcPolicy;
    if (!bp || typeof bp !== "object") return false;
    const enabled = bp.enabled === true;
    const manual = bp.syncMode === "MANUAL";
    const profileId =
      typeof bp.mappingProfileId === "string" && bp.mappingProfileId.trim().length > 0
        ? bp.mappingProfileId.trim()
        : null;
    return enabled && manual && Boolean(profileId);
  });
}

async function listDocuments(_userId, workspaceId, query = {}) {
  const take = Math.min(200, Math.max(1, Number(query.take || 50)));
  const pendingBcManual = isTruthyQueryFlag(query.pendingBcManual);
  if (pendingBcManual) {
    return listDocumentsPendingBcManual(workspaceId, take);
  }

  const status = query.status ? String(query.status) : null;
  const typeKey = query.type ? String(query.type) : null;
  const q = query.q ? String(query.q).trim() : "";

  /** @type {string[] | null} */
  let searchIds = null;
  if (q) {
    const pattern = `%${q}%`;
    const rows = await prisma.$queryRaw`
      SELECT d.id FROM "DocumentRecord" d
      WHERE d."workspaceId" = ${workspaceId}
        AND (
          d."fileName" ILIKE ${pattern}
          OR COALESCE(d."lastError", '') ILIKE ${pattern}
          OR d."extractionJson"::text ILIKE ${pattern}
        )
    `;
    searchIds = rows.map((r) => r.id);
    if (searchIds.length === 0) {
      return [];
    }
  }

  return prisma.documentRecord.findMany({
    where: {
      workspaceId,
      ...(status ? { status } : {}),
      ...(typeKey
        ? {
            documentType: {
              key: typeKey,
            },
          }
        : {}),
      ...(searchIds ? { id: { in: searchIds } } : {}),
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
    where: { id, workspaceId },
    include: {
      documentType: true,
      emailMessage: true,
      approvalRequests: {
        orderBy: { createdAt: "desc" },
        include: {
          assignee: { select: { id: true, email: true, fullName: true } },
        },
      },
    },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  return doc;
}

/**
 * Descarga el binario del documento desde el destino donde fue archivado
 * (SharePoint vía Graph, Amazon S3 o Azure Blob según `archiveStorageKind`).
 *
 * @returns {{ buffer: Buffer, contentType: string, fileName: string }}
 */
async function getDocumentFileBuffer(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, workspaceId },
    include: {
      workspace: { select: { aadTenantId: true } },
    },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  try {
    return await downloadArchivedDocumentBuffer(doc, doc.workspace);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      "No se pudo descargar el archivo",
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
    where: { id, workspaceId },
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
 * Sube (o re-sube) un `DocumentRecord` al destino de archivado del workspace
 * (SharePoint, Amazon S3 o Azure Blob) usando los datos ya extraídos.
 *
 * Flujo:
 *  1. Carga el documento con su workspace, email y tipo.
 *  2. Resuelve la integración de archivado (`storageIntegrationId` / legacy SharePoint).
 *  3. Recupera el binario del adjunto desde el correo (Graph), por SHA-256.
 *  4. Construye la ruta con `buildStoragePath` según tipo/workspace y extracción.
 *  5. Sube el archivo y persiste referencias (`archiveStorageKind`, columnas SharePoint reutilizadas para claves S3/Azure).
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Promise<{ document: import("@prisma/client").DocumentRecord, sharepointPath: string, webUrl: string | null }>}
 */
async function archiveDocumentToSharePoint(userId, workspaceId, id) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id, workspaceId },
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
  const archiveIntegrationId = getArchiveIntegrationId(doc.workspace.automationSettings);
  if (!archiveIntegrationId) {
    throw new HttpError(
      409,
      "El workspace no tiene una integración de archivado configurada en automatización."
    );
  }

  /** @type {import("@prisma/client").IntegrationConnection} */
  const integration = await assertArchiveIntegration(workspaceId, archiveIntegrationId);

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

  let uploadData;
  try {
    uploadData = await archiveUploadFromIntegration({
      tenantId: doc.workspace.aadTenantId,
      integration,
      integrationId: archiveIntegrationId,
      relativePath: relative,
      buffer: matching.buffer,
      contentType: matching.contentType,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const prefix = `${integration.kind}:`;
    await prisma.documentRecord.update({
      where: { id: doc.id },
      data: { lastError: `${prefix} ${msg.slice(0, 580)}` },
    });
    await createAuditEvent({
      action:
        integration.kind === INTEGRATION_KIND.SHAREPOINT
          ? AUDIT_ACTION.DOCUMENT_ARCHIVE_FAILED_SHAREPOINT
          : AUDIT_ACTION.DOCUMENT_ARCHIVE_FAILED_STORAGE,
      userId,
      workspaceId,
      entityType: "DocumentRecord",
      entityId: doc.id,
      metadata: {
        error: msg.slice(0, 600),
        phase: "manual_retry",
        storageKind: integration.kind,
      },
    });
    throw new HttpError(
      502,
      `No se pudo archivar el archivo (${integration.kind}): ${msg.slice(0, 300)}`
    );
  }

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: uploadData,
  });
  await createAuditEvent({
    action:
      integration.kind === INTEGRATION_KIND.SHAREPOINT
        ? AUDIT_ACTION.DOCUMENT_ARCHIVED_SHAREPOINT
        : AUDIT_ACTION.DOCUMENT_ARCHIVED_STORAGE,
    userId,
    workspaceId,
    entityType: "DocumentRecord",
    entityId: doc.id,
    metadata: {
      sharepointPath: relative,
      webUrl: uploadData.sharepointWebUrl || null,
      phase: "manual_retry",
      storageKind: integration.kind,
    },
  });

  return {
    document: updated,
    sharepointPath: relative,
    webUrl: uploadData.sharepointWebUrl || null,
  };
}

const patchExtractionBodySchema = z.object({
  fields: z.record(z.string(), z.any()),
});

/**
 * @param {unknown} raw
 * @param {string} fieldType
 */
function coerceFieldValueForSchema(raw, fieldType) {
  const t = (fieldType || "string").toLowerCase();
  if (raw === null || raw === undefined) return null;
  if (t === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const s = raw.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
      if (s === "") return null;
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  if (t === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === true || raw === false) return raw;
    const s = String(raw).trim().toLowerCase();
    if (["true", "1", "si", "sí", "yes"].includes(s)) return true;
    if (["false", "0", "no"].includes(s)) return false;
    return Boolean(raw);
  }
  if (t === "array" || t === "object") {
    if (typeof raw === "string") {
      const u = raw.trim();
      if (!u) return t === "array" ? [] : {};
      try {
        return JSON.parse(u);
      } catch {
        throw new HttpError(400, `JSON inválido para el campo (${t})`);
      }
    }
    return raw;
  }
  if (typeof raw === "string") return raw;
  return String(raw);
}

/**
 * Actualiza valores en extractionJson respetando formato plano o `fields.*` rich.
 *
 * @param {Record<string, unknown>} extraction
 * @param {string} key
 * @param {unknown} value
 */
function setExtractionKey(extraction, key, value) {
  const fields = extraction.fields;
  if (fields && typeof fields === "object" && Object.prototype.hasOwnProperty.call(fields, key)) {
    const cell = fields[key];
    if (
      cell &&
      typeof cell === "object" &&
      !Array.isArray(cell) &&
      Object.prototype.hasOwnProperty.call(cell, "value")
    ) {
      fields[key] = { ...cell, value };
    } else {
      fields[key] = value;
    }
  } else if (fields && typeof fields === "object") {
    fields[key] = value;
  } else {
    extraction[key] = value;
  }
}

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {unknown} body
 */
async function patchDocumentExtraction(userId, workspaceId, documentId, body) {
  const parsed = patchExtractionBodySchema.safeParse(body || {});
  if (!parsed.success) throw new HttpError(400, "Body inválido");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    include: { documentType: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  if (!doc.documentType) throw new HttpError(400, "El documento no tiene tipo documental");

  const schemaNorm = normalizeAiExtractionSchema(doc.documentType.aiExtractionSchema);
  const allowed = new Map(schemaNorm.fields.map((f) => [f.key, f]));
  const incoming = parsed.data.fields;
  const keys = Object.keys(incoming);
  if (keys.length === 0) throw new HttpError(400, "Sin campos para actualizar");
  if (keys.length > 80) throw new HttpError(400, "Demasiados campos");

  const extraction =
    doc.extractionJson && typeof doc.extractionJson === "object" && !Array.isArray(doc.extractionJson)
      ? JSON.parse(JSON.stringify(doc.extractionJson))
      : {};

  for (const key of keys) {
    const spec = allowed.get(key);
    if (!spec) {
      throw new HttpError(400, `Clave no definida en el esquema del tipo: ${key}`);
    }
    let coerced;
    try {
      coerced = coerceFieldValueForSchema(incoming[key], spec.type);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, String(e));
    }
    setExtractionKey(extraction, key, coerced);
  }

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: {
      extractionJson: extraction,
      updatedAt: new Date(),
    },
    include: {
      documentType: true,
      emailMessage: true,
      approvalRequests: {
        orderBy: { createdAt: "desc" },
        include: {
          assignee: { select: { id: true, email: true, fullName: true } },
        },
      },
    },
  });

  return updated;
}

/**
 * Overrides para ERP (`bcStagingJson`): mismas claves que la extracción IA.
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {unknown} body
 */
async function patchDocumentBcStaging(userId, workspaceId, documentId, body) {
  const parsed = patchExtractionBodySchema.safeParse(body || {});
  if (!parsed.success) throw new HttpError(400, "Body inválido");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    include: { documentType: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");
  if (!doc.documentType) throw new HttpError(400, "El documento no tiene tipo documental");

  const schemaNorm = normalizeAiExtractionSchema(doc.documentType.aiExtractionSchema);
  const allowed = new Map(schemaNorm.fields.map((f) => [f.key, f]));
  const incoming = parsed.data.fields;
  const keys = Object.keys(incoming);
  if (keys.length === 0) throw new HttpError(400, "Sin campos para actualizar");
  if (keys.length > 80) throw new HttpError(400, "Demasiados campos");

  const staging =
    doc.bcStagingJson &&
    typeof doc.bcStagingJson === "object" &&
    !Array.isArray(doc.bcStagingJson)
      ? JSON.parse(JSON.stringify(doc.bcStagingJson))
      : {};

  for (const key of keys) {
    const spec = allowed.get(key);
    if (!spec) {
      throw new HttpError(400, `Clave no definida en el esquema del tipo: ${key}`);
    }
    let coerced;
    try {
      coerced = coerceFieldValueForSchema(incoming[key], spec.type);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, String(e));
    }
    setExtractionKey(staging, key, coerced);
  }

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: {
      bcStagingJson: staging,
      updatedAt: new Date(),
    },
    include: {
      documentType: true,
      emailMessage: true,
      approvalRequests: {
        orderBy: { createdAt: "desc" },
        include: {
          assignee: { select: { id: true, email: true, fullName: true } },
        },
      },
    },
  });

  return updated;
}

module.exports = {
  listDocuments,
  getDocument,
  getDocumentFileBuffer,
  getDocumentLayout,
  archiveDocumentToSharePoint,
  patchDocumentExtraction,
  patchDocumentBcStaging,
};

