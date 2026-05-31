const { URLSearchParams } = require("node:url");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const HttpError = require("../utils/http-error");
const { signAuthFlow, readAuthFlow } = require("../lib/session");
const { sanitizeIntegrationConnection } = require("./integration.service");

const CONNECTORS = Object.freeze({
  graph: {
    kind: "email",
    displayName: "Microsoft 365",
    clientId: () => env.graphClientId,
    missingMessage: "GRAPH_CLIENT_ID no está configurado",
  },
  bc: {
    kind: "business_central",
    displayName: "Business Central",
    clientId: () => env.bcConnectorClientId,
    missingMessage: "BC_CONNECTOR_CLIENT_ID no está configurado",
  },
});

function connectorConfig(connector) {
  const cfg = CONNECTORS[connector];
  if (!cfg) throw new HttpError(404, "Conector Microsoft desconocido");
  return cfg;
}

function callbackUrl(connector) {
  const base = String(env.publicApiBaseUrl || "").replace(/\/+$/, "");
  return `${base}/integrations/${connector}/admin-consent/callback`;
}

async function ensureConnectorIntegration({ userId, workspaceId, connector }) {
  const cfg = connectorConfig(connector);
  const existing = await prisma.integrationConnection.findFirst({
    where: { workspaceId, kind: cfg.kind },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return existing;
  return prisma.integrationConnection.create({
    data: {
      userId,
      workspaceId,
      kind: cfg.kind,
      displayName: cfg.displayName,
      status: "DISCONNECTED",
      configJson: {},
    },
  });
}

async function buildAdminConsentUrl({ connector, userId, workspaceId }) {
  const cfg = connectorConfig(connector);
  const clientId = cfg.clientId();
  if (!clientId) throw new HttpError(500, cfg.missingMessage);

  await ensureConnectorIntegration({ userId, workspaceId, connector });

  const state = signAuthFlow({
    purpose: "microsoft-admin-consent",
    connector,
    userId,
    workspaceId,
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(connector),
    state,
  });
  return {
    url: `https://login.microsoftonline.com/common/adminconsent?${params.toString()}`,
    redirectUri: callbackUrl(connector),
  };
}

async function handleAdminConsentCallback({ connector, query }) {
  connectorConfig(connector);
  const state = typeof query.state === "string" ? query.state : "";
  if (!state) throw new HttpError(400, "Missing consent state");

  const flow = readAuthFlow(state);
  if (
    flow.purpose !== "microsoft-admin-consent" ||
    flow.connector !== connector ||
    !flow.userId ||
    !flow.workspaceId
  ) {
    throw new HttpError(400, "Invalid consent state");
  }

  const error = typeof query.error === "string" ? query.error : "";
  const errorDescription =
    typeof query.error_description === "string" ? query.error_description : "";
  const tenantId = typeof query.tenant === "string" ? query.tenant : "";
  const adminConsent = String(query.admin_consent || "").toLowerCase() === "true";
  const integration = await ensureConnectorIntegration({
    userId: String(flow.userId),
    workspaceId: String(flow.workspaceId),
    connector,
  });
  const prev =
    integration.configJson && typeof integration.configJson === "object"
      ? integration.configJson
      : {};

  const configJson = {
    ...prev,
    consentStatus: error ? "ERROR" : adminConsent ? "GRANTED" : "PENDING",
    adminConsentTenant: tenantId || prev.adminConsentTenant || null,
    tenantId: tenantId || prev.tenantId || null,
    consentGrantedAt: adminConsent && !error ? new Date().toISOString() : prev.consentGrantedAt || null,
    lastPermissionError: error ? errorDescription || error : null,
  };

  const updated = await prisma.integrationConnection.update({
    where: { id: integration.id },
    data: {
      status: error ? "ERROR" : adminConsent ? "CONNECTED" : "DISCONNECTED",
      configJson,
    },
  });

  return {
    ok: !error && adminConsent,
    connector,
    tenantId,
    error: error || null,
    errorDescription: errorDescription || null,
    integration: sanitizeIntegrationConnection(updated),
  };
}

module.exports = {
  buildAdminConsentUrl,
  handleAdminConsentCallback,
  ensureConnectorIntegration,
};
