const prisma = require("../lib/prisma");
const env = require("../config/env");
const { getGraphAccessToken } = require("../lib/graph-client");
const {
  getBusinessCentralIntegration,
  resolveBcBearerToken,
  listBcEnvironments,
  listBcODataCompanies,
  bcErpFetch,
} = require("./bc-erp-client.service");
const { getWebhookDiagnostics } = require("./email-graph.service");
const { sanitizeIntegrationConnection } = require("./integration.service");

function cfgOf(row) {
  return row?.configJson && typeof row.configJson === "object" ? row.configJson : {};
}

async function findIntegration(workspaceId, kind) {
  return prisma.integrationConnection.findFirst({
    where: { workspaceId, kind },
    orderBy: { updatedAt: "desc" },
  });
}

async function updateIntegrationCheck(row, patch) {
  if (!row) return null;
  const cfg = cfgOf(row);
  const updated = await prisma.integrationConnection.update({
    where: { id: row.id },
    data: {
      status: patch.status || row.status,
      configJson: {
        ...cfg,
        lastPermissionCheck: new Date().toISOString(),
        lastPermissionError: patch.error || null,
      },
    },
  });
  return sanitizeIntegrationConnection(updated);
}

async function getGraphConnectorStatus(workspace, userId) {
  const integration = await findIntegration(workspace.id, "email");
  const cfg = cfgOf(integration);
  const tenantId =
    cfg.tenantId || cfg.adminConsentTenant || workspace.aadTenantId || null;
  const steps = [];

  steps.push({
    id: "consent",
    label: "Consentimiento Microsoft 365",
    ok: cfg.consentStatus === "GRANTED" || integration?.status === "CONNECTED",
    action:
      cfg.consentStatus === "GRANTED" || integration?.status === "CONNECTED"
        ? null
        : "Concedé consentimiento de administrador para Microsoft 365.",
  });

  let tokenOk = false;
  let tokenError = null;
  if (!env.graphClientId || !env.graphClientSecret) {
    tokenError = "GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET no están configurados.";
  } else if (!tenantId) {
    tokenError = "No hay tenant conectado para Microsoft 365.";
  } else {
    try {
      await getGraphAccessToken(String(tenantId));
      tokenOk = true;
    } catch (error) {
      tokenError = error instanceof Error ? error.message : String(error);
    }
  }
  steps.push({
    id: "token",
    label: "Token app-only Graph",
    ok: tokenOk,
    action: tokenOk ? null : tokenError,
  });

  const webhook = await getWebhookDiagnostics(userId, workspace.id);
  const webhookOk =
    Array.isArray(webhook.subscriptions) &&
    webhook.subscriptions.length > 0 &&
    webhook.subscriptions.some((s) => s.graphOk && s.urlMatchesExpected);
  steps.push({
    id: "webhook",
    label: "Webhook de correo",
    ok: webhookOk,
    action: webhookOk
      ? null
      : "Conectá un buzón y verificá que PUBLIC_API_BASE_URL apunte al ngrok/dominio actual.",
  });

  const ready = tokenOk && webhookOk;
  const updated = await updateIntegrationCheck(integration, {
    status: ready ? "CONNECTED" : tokenOk ? "DISCONNECTED" : "ERROR",
    error: tokenError,
  });

  return {
    connector: "graph",
    label: "Microsoft 365",
    ready,
    tenantId,
    integration: updated || (integration ? sanitizeIntegrationConnection(integration) : null),
    steps,
    webhook,
  };
}

async function getBusinessCentralStatus(workspace) {
  const integration = await findIntegration(workspace.id, "business_central");
  const cfg = cfgOf(integration);
  const tenantId =
    cfg.tenantId || cfg.adminConsentTenant || workspace.aadTenantId || null;
  const environment = typeof cfg.environment === "string" ? cfg.environment : "";
  const companyId = typeof cfg.companyId === "string" ? cfg.companyId : "";
  const steps = [];

  steps.push({
    id: "consent",
    label: "Consentimiento Business Central",
    ok: cfg.consentStatus === "GRANTED" || integration?.status === "CONNECTED",
    action:
      cfg.consentStatus === "GRANTED" || integration?.status === "CONNECTED"
        ? null
        : "Concedé consentimiento de administrador para Business Central.",
  });

  let tokenOk = false;
  let tokenError = null;
  if (!integration) {
    tokenError = "La integración Business Central todavía no existe.";
  } else if (!tenantId) {
    tokenError = "No hay tenant conectado para Business Central.";
  } else if (!env.bcConnectorClientId && !cfg.oauthClientId) {
    tokenError = "BC_CONNECTOR_CLIENT_ID no está configurado.";
  } else {
    try {
      const ctx = await getBusinessCentralIntegration(workspace.id);
      const mergedCtx =
        ctx && tenantId
          ? {
              integration: {
                ...ctx.integration,
                configJson: { ...cfg, tenantId },
              },
            }
          : ctx;
      const token = mergedCtx ? await resolveBcBearerToken(mergedCtx) : null;
      tokenOk = Boolean(token);
      if (!tokenOk) tokenError = "No se pudo obtener token para Business Central.";
    } catch (error) {
      tokenError = error instanceof Error ? error.message : String(error);
    }
  }
  steps.push({
    id: "token",
    label: "Token app-only BC",
    ok: tokenOk,
    action: tokenOk ? null : tokenError,
  });

  let environmentsOk = false;
  let environments = [];
  let environmentsError = null;
  if (tokenOk && tenantId) {
    try {
      environments = await listBcEnvironments(workspace.id, {
        tenantId: String(tenantId),
      });
      environmentsOk = true;
    } catch (error) {
      environmentsError = error instanceof Error ? error.message : String(error);
      if (environment) {
        environments = [
          {
            name: environment,
            type: "configured",
            aadTenantId: String(tenantId),
          },
        ];
      }
    }
  }
  steps.push({
    id: "environments",
    label: "Entornos BC",
    ok: environmentsOk || Boolean(environment),
    action: environmentsOk
      ? null
      : environment
        ? "Admin Center no permitió listar entornos, pero seguimos con el entorno configurado. Podés escribirlo manualmente y cargar empresas."
        : environmentsError || "Si Admin Center no está disponible, escribí el nombre del entorno manualmente y cargá empresas.",
  });

  let companiesOk = false;
  let companies = [];
  let companiesError = null;
  if (tokenOk && tenantId && environment) {
    try {
      companies = await listBcODataCompanies(workspace.id, {
        tenantId: String(tenantId),
        environment,
      });
      companiesOk = companies.length > 0;
    } catch (error) {
      companiesError = error instanceof Error ? error.message : String(error);
    }
  }
  steps.push({
    id: "companies",
    label: "Empresas",
    ok: companiesOk,
    action: companiesOk
      ? null
      : companiesError || "Elegí un entorno para cargar empresas.",
  });

  let extensionOk = false;
  let extensionError = null;
  if (tokenOk && tenantId && environment && companyId) {
    try {
      const res = await bcErpFetch(workspace.id, "/targets", { method: "GET" });
      extensionOk = res.ok;
      if (!res.ok) extensionError = `BC HTTP ${res.status}`;
    } catch (error) {
      extensionError = error instanceof Error ? error.message : String(error);
    }
  }
  steps.push({
    id: "extension",
    label: "Extensión Parseva",
    ok: extensionOk,
    action: extensionOk
      ? null
      : extensionError ||
        "Instalá Parseva_App >= 1.0.0.12 y asigná el permission set Parseva API a la app.",
  });

  const ready = tokenOk && companiesOk && extensionOk;
  const updated = await updateIntegrationCheck(integration, {
    status: ready ? "CONNECTED" : tokenOk ? "DISCONNECTED" : "ERROR",
    error: ready ? null : tokenError || companiesError || extensionError || environmentsError,
  });

  return {
    connector: "bc",
    label: "Business Central",
    ready,
    tenantId,
    environment,
    companyId,
    integration: updated || (integration ? sanitizeIntegrationConnection(integration) : null),
    steps,
    environments,
    companies,
  };
}

module.exports = {
  getGraphConnectorStatus,
  getBusinessCentralStatus,
};
