const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { normalizePolicies } = require("./document-type-policies");
const { queueBcSync } = require("./bc-sync.service");
const { normalizeRole } = require("../constants/rbac");

const approvePayloadSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

const rejectPayloadSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, "Motivo de rechazo requerido")
    .max(2000),
});

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {unknown} payload
 * @param {string | null | undefined} membershipRole Rol en el workspace (para override ADMIN).
 */
async function approveDocument(userId, workspaceId, documentId, payload, membershipRole) {
  const parsed = approvePayloadSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid approval payload");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    include: { documentType: true },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const pending = await prisma.approvalRequest.findFirst({
    where: { documentId: doc.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  if (pending?.assigneeUserId) {
    const isAdmin = normalizeRole(membershipRole) === "ADMIN";
    if (!isAdmin && pending.assigneeUserId !== userId) {
      throw new HttpError(403, "Solo el responsable asignado o un administrador puede aprobar");
    }
  }

  let approval;
  if (pending) {
    approval = await prisma.approvalRequest.update({
      where: { id: pending.id },
      data: {
        status: "APPROVED",
        createdByUserId: pending.createdByUserId || userId,
        decidedByUserId: userId,
        decisionNote: parsed.data.note || null,
        decidedAt: new Date(),
      },
    });
  } else {
    approval = await prisma.approvalRequest.create({
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
  }

  const pol = normalizePolicies(doc.documentType || {});
  const requireApproval = doc.documentType?.requireApprovalBeforeErp ?? true;

  /** Tras aprobar: ERP_QUEUED solo si BC encola en ese momento (AFTER_APPROVAL). Modo MANUAL queda en APPROVED hasta envío desde la cola. */
  let nextStatus;
  if (!requireApproval) {
    nextStatus = "APPROVED";
  } else if (
    pol.bcPolicy.enabled &&
    pol.bcPolicy.syncMode === "AFTER_APPROVAL" &&
    pol.bcPolicy.mappingProfileId
  ) {
    nextStatus = "ERP_QUEUED";
  } else {
    nextStatus = "APPROVED";
  }

  const updated = await prisma.documentRecord.update({
    where: { id: doc.id },
    data: {
      status: nextStatus,
    },
  });

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

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {unknown} payload
 * @param {string | null | undefined} membershipRole
 */
async function rejectDocument(userId, workspaceId, documentId, payload, membershipRole) {
  const parsed = rejectPayloadSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid rejection payload");

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const pending = await prisma.approvalRequest.findFirst({
    where: { documentId: doc.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  if (pending?.assigneeUserId) {
    const isAdmin = normalizeRole(membershipRole) === "ADMIN";
    if (!isAdmin && pending.assigneeUserId !== userId) {
      throw new HttpError(403, "Solo el responsable asignado o un administrador puede rechazar");
    }
  }

  let approval;
  if (pending) {
    approval = await prisma.approvalRequest.update({
      where: { id: pending.id },
      data: {
        status: "REJECTED",
        createdByUserId: pending.createdByUserId || userId,
        decidedByUserId: userId,
        decisionNote: parsed.data.note || null,
        decidedAt: new Date(),
      },
    });
  } else {
    approval = await prisma.approvalRequest.create({
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
  }

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

