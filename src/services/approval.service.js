const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { normalizePolicies } = require("./document-type-policies");
const { queueBcSync } = require("./bc-sync.service");

const decisionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

async function approveDocument(userId, workspaceId, documentId, payload) {
  const parsed = decisionSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid approval payload");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, userId, workspaceId },
    include: { documentType: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const approval = await prisma.approvalRequest.create({
    data: {
      workspaceId,
      documentId: doc.id,
      status: "APPROVED",
      createdByUserId: userId,
      decidedByUserId: userId,
      decisionNote: parsed.data.note || null,
      decidedAt: new Date(),
    },
  });

  const requireApproval = doc.documentType?.requireApprovalBeforeErp ?? true;
  const nextStatus = requireApproval ? "ERP_QUEUED" : "APPROVED";

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: {
      status: nextStatus,
    },
  });

  const pol = normalizePolicies(doc.documentType || {});
  if (
    pol.bcPolicy.enabled &&
    pol.bcPolicy.syncMode === "AFTER_APPROVAL" &&
    pol.bcPolicy.mappingProfileId
  ) {
    try {
      await queueBcSync(workspaceId, updated.id, pol.bcPolicy.mappingProfileId);
    } catch {
      /* caller puede reintentar sync manual */
    }
  }

  return { document: updated, approval };
}

async function rejectDocument(userId, workspaceId, documentId, payload) {
  const parsed = decisionSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid rejection payload");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, userId, workspaceId },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const approval = await prisma.approvalRequest.create({
    data: {
      workspaceId,
      documentId: doc.id,
      status: "REJECTED",
      createdByUserId: userId,
      decidedByUserId: userId,
      decisionNote: parsed.data.note || null,
      decidedAt: new Date(),
    },
  });

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: { status: "REJECTED" },
  });

  return { document: updated, approval };
}

module.exports = {
  approveDocument,
  rejectDocument,
};

