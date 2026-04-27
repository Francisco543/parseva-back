const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

const targetSchema = z.object({
  key: z.string().min(2).max(80),
  displayName: z.string().min(2).max(120),
  category: z.string().max(80).optional().nullable(),
  mode: z.enum(["CURATED", "EXTENSION"]).optional().default("CURATED"),
  enabled: z.boolean().optional().default(true),
  schemaJson: z.any().optional(),
});

const fieldSchema = z.object({
  bcTargetId: z.string().min(1),
  key: z.string().min(1).max(80),
  displayName: z.string().min(1).max(120),
  dataType: z.string().min(1).max(40),
  required: z.boolean().optional().default(false),
  allowWrite: z.boolean().optional().default(true),
});

const profileSchema = z.object({
  documentTypeId: z.string().min(1),
  bcTargetId: z.string().min(1),
  name: z.string().min(2).max(120),
  enabled: z.boolean().optional().default(true),
  fieldMap: z.any(),
  transformMap: z.any().optional().nullable(),
});

async function seedCuratedTargets(workspaceId) {
  const curated = [
    { key: "purchaseOrder", displayName: "Purchase Order", category: "purchase", mode: "CURATED" },
    { key: "purchaseInvoice", displayName: "Purchase Invoice", category: "purchase", mode: "CURATED" },
    { key: "purchaseCreditMemo", displayName: "Purchase Credit Memo", category: "purchase", mode: "CURATED" },
    { key: "salesInvoice", displayName: "Sales Invoice", category: "sales", mode: "CURATED" },
  ];
  for (const item of curated) {
    await prisma.bcTarget.upsert({
      where: { workspaceId_key: { workspaceId, key: item.key } },
      create: { workspaceId, ...item, enabled: true, schemaJson: null },
      update: { displayName: item.displayName, category: item.category, enabled: true },
    });
  }
}

async function listBcTargets(workspaceId) {
  await seedCuratedTargets(workspaceId);
  return prisma.bcTarget.findMany({
    where: { workspaceId },
    orderBy: [{ mode: "asc" }, { key: "asc" }],
    include: { fields: true, extensionConfig: true },
  });
}

async function upsertBcTarget(workspaceId, id, payload) {
  const parsed = targetSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC target payload");
  if (!id) {
    return prisma.bcTarget.create({ data: { workspaceId, ...parsed.data } });
  }
  const existing = await prisma.bcTarget.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC target not found");
  return prisma.bcTarget.update({ where: { id }, data: parsed.data });
}

async function upsertBcField(workspaceId, id, payload) {
  const parsed = fieldSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC field payload");
  const data = parsed.data;
  const target = await prisma.bcTarget.findFirst({ where: { id: data.bcTargetId, workspaceId } });
  if (!target) throw new HttpError(404, "BC target not found");
  if (!id) {
    return prisma.bcField.create({ data: { workspaceId, ...data } });
  }
  const existing = await prisma.bcField.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC field not found");
  return prisma.bcField.update({ where: { id }, data });
}

async function listMappingProfiles(workspaceId) {
  return prisma.bcMappingProfile.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      documentType: { select: { id: true, key: true, displayName: true } },
      bcTarget: { select: { id: true, key: true, displayName: true, mode: true } },
    },
  });
}

async function upsertMappingProfile(workspaceId, id, payload) {
  const parsed = profileSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC mapping profile payload");
  const data = parsed.data;
  if (!id) {
    return prisma.bcMappingProfile.create({ data: { workspaceId, ...data } });
  }
  const existing = await prisma.bcMappingProfile.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC mapping profile not found");
  return prisma.bcMappingProfile.update({ where: { id }, data });
}

async function upsertExtensionTarget(workspaceId, bcTargetId, payload) {
  const target = await prisma.bcTarget.findFirst({ where: { id: bcTargetId, workspaceId } });
  if (!target) throw new HttpError(404, "BC target not found");
  return prisma.bcExtensionTarget.upsert({
    where: { bcTargetId },
    create: {
      workspaceId,
      bcTargetId,
      approvalStatus: payload.approvalStatus || "PENDING",
      sourceSchema: payload.sourceSchema || null,
      reviewerUserId: payload.reviewerUserId || null,
      reviewNote: payload.reviewNote || null,
    },
    update: {
      approvalStatus: payload.approvalStatus,
      sourceSchema: payload.sourceSchema,
      reviewerUserId: payload.reviewerUserId,
      reviewNote: payload.reviewNote,
    },
  });
}

module.exports = {
  listBcTargets,
  upsertBcTarget,
  upsertBcField,
  listMappingProfiles,
  upsertMappingProfile,
  upsertExtensionTarget,
};

