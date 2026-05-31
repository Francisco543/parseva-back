/**
 * Notas internas por documento.
 *
 * @module services/document-note
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
 */
async function listDocumentNotes(userId, workspaceId, documentId) {
  await assertDocument(userId, workspaceId, documentId);
  return prisma.documentNote.findMany({
    where: { documentId },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
    },
  });
}

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {{ body: string }} input
 */
async function createDocumentNote(userId, workspaceId, documentId, input) {
  await assertDocument(userId, workspaceId, documentId);
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new HttpError(400, "El texto de la nota es obligatorio");
  return prisma.documentNote.create({
    data: {
      documentId,
      userId,
      body: body.slice(0, 20000),
    },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
    },
  });
}

module.exports = {
  listDocumentNotes,
  createDocumentNote,
};
