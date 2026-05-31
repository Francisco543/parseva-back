/**
 * Reprocesa un documento existente volviendo a ejecutar el mismo pipeline que la subida manual.
 *
 * @module services/document-reprocess
 */

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { getDocumentFileBuffer } = require("./document.service");
const { ingestManualPdfs } = require("./manual-document-ingest.service");

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {{ forcedDocumentTypeId?: string }} [opts]
 */
async function reprocessDocument(userId, workspaceId, documentId, opts = {}) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
  });
  if (!doc) {
    throw new HttpError(404, "Document not found");
  }

  let buffer;
  try {
    const fb = await getDocumentFileBuffer(userId, workspaceId, documentId);
    buffer = fb.buffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      422,
      "No hay PDF disponible para reprocesar. Archivá el documento en SharePoint primero o volvé a subir el archivo.",
      msg.slice(0, 200)
    );
  }

  const forcedDocumentTypeId =
    typeof opts.forcedDocumentTypeId === "string" && opts.forcedDocumentTypeId.trim()
      ? opts.forcedDocumentTypeId.trim()
      : undefined;

  return ingestManualPdfs({
    userId,
    workspaceId,
    files: [
      {
        buffer,
        originalname: doc.fileName || "documento.pdf",
        mimetype: doc.contentType || "application/pdf",
      },
    ],
    forcedDocumentTypeId,
    suppressDuplicateInResults: true,
  });
}

module.exports = {
  reprocessDocument,
};
