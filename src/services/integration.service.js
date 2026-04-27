const prisma = require("../lib/prisma");
const { z } = require("zod");
const HttpError = require("../utils/http-error");

const ALLOWED_KINDS = ["email", "sharepoint", "business_central"];
const createIntegrationSchema = z.object({
  kind: z.enum(ALLOWED_KINDS),
  displayName: z.string().trim().min(2).max(120),
  config: z.record(z.string(), z.unknown()).optional(),
});

const updateIntegrationSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  status: z.string().trim().min(2).max(40).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

async function listIntegrations(userId, workspaceId) {
  return prisma.integrationConnection.findMany({
    where: { userId, workspaceId },
    orderBy: { createdAt: "desc" },
  });
}

async function createIntegration(userId, workspaceId, input) {
  const parsed = createIntegrationSchema.safeParse(input || {});
  if (!parsed.success) throw new HttpError(400, "Invalid integration payload");
  const { kind, displayName, config } = parsed.data;

  return prisma.integrationConnection.create({
    data: {
      userId,
      workspaceId,
      kind,
      displayName: displayName.trim(),
      configJson: config || {},
    },
  });
}

async function updateIntegration(userId, workspaceId, id, input) {
  const integration = await prisma.integrationConnection.findFirst({
    where: { id, userId, workspaceId },
  });
  if (!integration) throw new HttpError(404, "Integration not found");

  const parsed = updateIntegrationSchema.safeParse(input || {});
  if (!parsed.success) throw new HttpError(400, "Invalid integration payload");

  const data = {};
  if (parsed.data.displayName) data.displayName = parsed.data.displayName;
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.config) {
    const prev =
      integration.configJson && typeof integration.configJson === "object"
        ? integration.configJson
        : {};
    data.configJson = { ...prev, ...parsed.data.config };
  }

  if (
    integration.kind === "sharepoint" &&
    !parsed.data.status
  ) {
    const cfg =
      data.configJson !== undefined
        ? data.configJson
        : integration.configJson && typeof integration.configJson === "object"
          ? integration.configJson
          : null;
    if (cfg && cfg.siteId && cfg.driveId) {
      data.status = "CONNECTED";
    }
  }

  return prisma.integrationConnection.update({
    where: { id },
    data,
  });
}

module.exports = {
  listIntegrations,
  createIntegration,
  updateIntegration,
};
