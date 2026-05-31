const prisma = require("../lib/prisma");
const { z } = require("zod");
const HttpError = require("../utils/http-error");
const {
  resolveBcApiBaseUrl,
  invalidateBcTokenCache,
  bcWorkspaceHasResolvableAuth,
} = require("./bc-erp-client.service");

const ALLOWED_KINDS = ["email", "sharepoint", "business_central", "s3", "azure_blob"];
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

const BC_SECRET_KEYS = ["oauthClientSecret", "apiKey", "apiToken", "accessToken"];

/**
 * No exponer secretos en respuestas JSON (front solo necesita flags).
 *
 * @param {import("@prisma/client").IntegrationConnection} row
 */
function sanitizeIntegrationConnection(row) {
  if (!row || row.kind !== "business_central") return row;
  const cfg = row.configJson && typeof row.configJson === "object" ? row.configJson : {};
  const next = { ...cfg };
  if (typeof next.oauthClientSecret === "string" && next.oauthClientSecret.length > 0) {
    next.oauthClientSecretSet = true;
    delete next.oauthClientSecret;
  }
  if (typeof next.apiKey === "string" && next.apiKey.length > 0) {
    next.manualBearerSet = true;
    delete next.apiKey;
  }
  if (typeof next.apiToken === "string" && next.apiToken.length > 0) {
    next.manualBearerSet = true;
    delete next.apiToken;
  }
  if (typeof next.accessToken === "string" && next.accessToken.length > 0) {
    next.manualBearerSet = true;
    delete next.accessToken;
  }
  return { ...row, configJson: next };
}

async function listIntegrations(workspaceId) {
  const rows = await prisma.integrationConnection.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(sanitizeIntegrationConnection);
}

async function createIntegration(userId, workspaceId, input) {
  const parsed = createIntegrationSchema.safeParse(input || {});
  if (!parsed.success) throw new HttpError(400, "Invalid integration payload");
  const { kind, displayName, config } = parsed.data;

  const created = await prisma.integrationConnection.create({
    data: {
      userId,
      workspaceId,
      kind,
      displayName: displayName.trim(),
      configJson: config || {},
    },
  });
  return sanitizeIntegrationConnection(created);
}

async function updateIntegration(userId, workspaceId, id, input) {
  const integration = await prisma.integrationConnection.findFirst({
    where: { id, workspaceId },
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
    const incoming = { ...parsed.data.config };

    if (integration.kind === "business_central") {
      for (const k of BC_SECRET_KEYS) {
        if (incoming[k] === "" || incoming[k] === undefined) {
          delete incoming[k];
        }
      }
      for (const k of ["oauthClientId", "oauthTenantId"]) {
        if (incoming[k] === "" || incoming[k] === undefined) {
          delete incoming[k];
        }
      }
      invalidateBcTokenCache(integration.id);
    }

    data.configJson = { ...prev, ...incoming };
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

  if (integration.kind === "business_central" && !parsed.data.status) {
    const cfg =
      data.configJson !== undefined
        ? data.configJson
        : integration.configJson && typeof integration.configJson === "object"
          ? integration.configJson
          : null;
    if (cfg && typeof cfg === "object") {
      const url = resolveBcApiBaseUrl(/** @type {Record<string, unknown>} */ (cfg));
      if (url && url.includes("/companies(") && bcWorkspaceHasResolvableAuth(cfg)) {
        data.status = "CONNECTED";
      }
    }
  }

  const updated = await prisma.integrationConnection.update({
    where: { id },
    data,
  });
  return sanitizeIntegrationConnection(updated);
}

module.exports = {
  listIntegrations,
  createIntegration,
  updateIntegration,
  sanitizeIntegrationConnection,
};
