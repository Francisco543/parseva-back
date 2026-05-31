/**
 * Feedback de usuario sobre campos extraídos (calidad / auditoría).
 *
 * @module services/extraction-field-feedback
 */

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

async function assertDocument(userId, workspaceId, documentId) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    select: { id: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");
}

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {{ fieldKey: string, reportedValue?: unknown, comment?: string | null }} input
 */
async function createFieldFeedback(userId, workspaceId, documentId, input) {
  await assertDocument(userId, workspaceId, documentId);
  const fieldKey = typeof input.fieldKey === "string" ? input.fieldKey.trim() : "";
  if (!fieldKey) throw new HttpError(400, "fieldKey obligatorio");

  return prisma.extractionFieldFeedback.create({
    data: {
      documentId,
      userId,
      fieldKey: fieldKey.slice(0, 120),
      reportedValue:
        input.reportedValue !== undefined ? input.reportedValue : undefined,
      comment:
        typeof input.comment === "string" ? input.comment.trim().slice(0, 2000) : null,
    },
  });
}

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 */
async function listFieldFeedback(userId, workspaceId, documentId) {
  await assertDocument(userId, workspaceId, documentId);
  return prisma.extractionFieldFeedback.findMany({
    where: { documentId },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
    },
  });
}

module.exports = {
  createFieldFeedback,
  listFieldFeedback,
};
