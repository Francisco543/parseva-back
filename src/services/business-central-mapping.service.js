const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

const patchSchema = z.object({
  documentTypeId: z.string().min(1),
  enabled: z.boolean().optional(),
  targetTable: z.string().trim().min(2).max(120).optional(),
  fieldMap: z.any().optional(),
});

async function listMappings(workspaceId) {
  return prisma.businessCentralMapping.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    include: { documentType: { select: { id: true, key: true, displayName: true } } },
  });
}

async function upsertMapping(workspaceId, payload) {
  const parsed = patchSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid Business Central mapping payload");

  const dt = await prisma.documentType.findFirst({
    where: { id: parsed.data.documentTypeId, workspaceId },
  });
  if (!dt) throw new HttpError(404, "Document type not found");

  const data = {
    workspaceId,
    documentTypeId: dt.id,
    enabled: parsed.data.enabled ?? false,
    targetTable: parsed.data.targetTable || "UNMAPPED",
    fieldMap: parsed.data.fieldMap ?? {},
  };

  return prisma.businessCentralMapping.upsert({
    where: { workspaceId_documentTypeId: { workspaceId, documentTypeId: dt.id } },
    create: data,
    update: {
      enabled: parsed.data.enabled,
      targetTable: parsed.data.targetTable,
      fieldMap: parsed.data.fieldMap,
    },
  });
}

module.exports = {
  listMappings,
  upsertMapping,
};

