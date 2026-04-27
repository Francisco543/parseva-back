const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

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

module.exports = {
  listDocuments,
  getDocument,
};

