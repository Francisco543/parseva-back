/**
 * @file Servicios de integración con Microsoft Graph para correos:
 * creación/listado de suscripciones, manejo de notificaciones (webhook) y
 * herramientas de diagnóstico de buzones y URLs.
 *
 * @module services/email-graph
 */

const crypto = require("node:crypto");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { graphRequest } = require("../lib/graph-client");
const HttpError = require("../utils/http-error");
const env = require("../config/env");
const { ingestEmailEvent } = require("./email-automation.service");
const { logger } = require("../lib/logger");
const { INTEGRATION_KIND, INTEGRATION_STATUS } = require("../constants");
const {
  OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS,
} = require("../constants/graph-subscription");

const createSubscriptionSchema = z.object({
  integrationId: z.string().min(1),
  mailbox: z.string().email(),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageId(notification) {
  const rd = notification.resourceData || {};
  if (rd.id) return String(rd.id);

  const odataId = rd["@odata.id"];
  if (typeof odataId === "string") {
    const parts = odataId.split("/");
    const last = parts[parts.length - 1];
    if (last) return last.split("?")[0];
  }

  const resource = notification.resource;
  if (typeof resource === "string") {
    const idx = resource.toLowerCase().lastIndexOf("/messages/");
    if (idx !== -1) {
      const id = resource.slice(idx + "/messages/".length).split("?")[0];
      if (id) return id;
    }
  }

  return null;
}

function isRetryableGraphError(error) {
  if (!(error instanceof HttpError)) return false;
  const text = String(error.details || "").toLowerCase();
  return (
    text.includes("404") ||
    text.includes("notfound") ||
    text.includes("mailboxnotenabled") ||
    text.includes("errornonexistentobject") ||
    text.includes("erroritemnotfound")
  );
}

async function fetchMessageMeta(tenantId, mailbox, messageId) {
  const path = `/users/${encodeURIComponent(mailbox)}/messages/${messageId}?$select=id,subject,receivedDateTime,from,bodyPreview`;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await graphRequest(path, { method: "GET" }, { tenantId });
    } catch (error) {
      if (attempt < maxAttempts && isRetryableGraphError(error)) {
        await sleep(2000 * attempt);
        continue;
      }
      throw error;
    }
  }
  return null;
}

/**
 * Logger contextual para el flujo del webhook de Graph.
 * Usa pino bajo el capó; el nivel `debug` solo se imprime con `GRAPH_WEBHOOK_LOG=true`.
 *
 * @param {"debug" | "info" | "warn" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function webhookLog(level, message, extra = undefined) {
  if (process.env.GRAPH_WEBHOOK_LOG !== "true" && level === "debug") return;
  const meta = { component: "graph-webhook", ...(extra || {}) };
  if (level === "error") logger.error(meta, message);
  else if (level === "warn") logger.warn(meta, message);
  else if (level === "debug") logger.debug(meta, message);
  else logger.info(meta, message);
}

async function createGraphSubscription(userId, workspaceId, payload) {
  const parsed = createSubscriptionSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid subscription payload");

  const integration = await prisma.integrationConnection.findFirst({
    where: {
      id: parsed.data.integrationId,
      workspaceId,
      kind: INTEGRATION_KIND.EMAIL,
    },
  });
  if (!integration) throw new HttpError(404, "Email integration not found");
  if (!integration.workspaceId) {
    throw new HttpError(400, "Integration is missing workspace context");
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: integration.workspaceId },
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const previousSubs = await prisma.emailGraphSubscription.findMany({
    where: { integrationId: integration.id, workspaceId },
  });

  for (const prev of previousSubs) {
    try {
      await graphRequest(
        `/subscriptions/${prev.subscriptionId}`,
        { method: "DELETE" },
        { tenantId: workspace.aadTenantId }
      );
    } catch {
      /* ya borrada / vencida en Graph */
    }
    await prisma.emailGraphSubscription.delete({ where: { id: prev.id } });
  }

  const clientState = crypto.randomUUID();
  const expiration = new Date(Date.now() + OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS);
  const mailbox = parsed.data.mailbox;

  const resource = `/users/${mailbox}/messages`;
  const notificationUrl = `${env.publicApiBaseUrl}/email/graph/webhook`;

  const response = await graphRequest(
    "/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource,
        expirationDateTime: expiration.toISOString(),
        clientState,
      }),
    },
    {
      tenantId: workspace.aadTenantId,
    }
  );

  await prisma.integrationConnection.update({
    where: { id: integration.id },
    data: {
      status: INTEGRATION_STATUS.CONNECTED,
      configJson: {
        ...(integration.configJson || {}),
        mailbox,
      },
    },
  });

  return prisma.emailGraphSubscription.create({
    data: {
      userId,
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      subscriptionId: response.id,
      clientState,
      resource,
      expirationDateTime: new Date(response.expirationDateTime),
    },
  });
}

async function listGraphSubscriptions(_userId, workspaceId) {
  return prisma.emailGraphSubscription.findMany({
    where: { workspaceId },
    include: {
      integration: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

async function handleGraphNotification(body) {
  const notifications = body?.value || [];
  if (!notifications.length) {
    webhookLog("debug", "empty notification batch");
    return;
  }

  for (const notification of notifications) {
    try {
      const subscription = await prisma.emailGraphSubscription.findUnique({
        where: { subscriptionId: notification.subscriptionId },
        include: { integration: true, workspace: true },
      });
      if (!subscription) {
        webhookLog(
          "warn",
          `no subscription row for ${notification.subscriptionId}`
        );
        continue;
      }
      if (subscription.clientState !== notification.clientState) {
        webhookLog("warn", "clientState mismatch (ignored)");
        continue;
      }

      const messageId = extractMessageId(notification);
      if (!messageId) {
        webhookLog("warn", "could not extract message id", {
          resource: notification.resource,
        });
        continue;
      }

      const integrationConfig = subscription.integration.configJson || {};
      const mailbox = integrationConfig.mailbox;
      if (!mailbox) {
        webhookLog("warn", "integration has no mailbox in config");
        continue;
      }

      const tenantId = subscription.workspace?.aadTenantId;
      if (!tenantId) {
        webhookLog("warn", "workspace missing aadTenantId");
        continue;
      }

      const email = await fetchMessageMeta(tenantId, mailbox, messageId);

      await ingestEmailEvent(subscription.userId, subscription.workspaceId, {
        integrationId: subscription.integrationId,
        externalId: email.id,
        sender: email?.from?.emailAddress?.address || "unknown@example.com",
        subject: email.subject || "(no subject)",
        receivedAt: email.receivedDateTime || new Date().toISOString(),
        rawPayload: email,
      });

      webhookLog("debug", `ingested message ${messageId}`);
    } catch (error) {
      webhookLog("error", "notification failed", {
        message: error instanceof Error ? error.message : error,
        details: error instanceof HttpError ? error.details : undefined,
      });
    }
  }
}

async function diagnoseMailbox(workspaceId, mailbox) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  try {
    const user = await graphRequest(
      `/users/${encodeURIComponent(mailbox)}?$select=id,mail,userPrincipalName,accountEnabled`,
      { method: "GET" },
      { tenantId: workspace.aadTenantId }
    );

    try {
      const mailboxSettings = await graphRequest(
        `/users/${encodeURIComponent(mailbox)}/mailboxSettings`,
        { method: "GET" },
        { tenantId: workspace.aadTenantId }
      );

      return {
        ok: true,
        mailbox,
        tenantId: workspace.aadTenantId,
        user: {
          id: user.id,
          mail: user.mail,
          userPrincipalName: user.userPrincipalName,
          accountEnabled: user.accountEnabled,
        },
        mailboxSettingsAvailable: Boolean(mailboxSettings),
      };
    } catch (error) {
      return {
        ok: false,
        mailbox,
        tenantId: workspace.aadTenantId,
        userFound: true,
        detail: error.message,
      };
    }
  } catch (error) {
    return {
      ok: false,
      mailbox,
      tenantId: workspace.aadTenantId,
      userFound: false,
      detail: error.message,
    };
  }
}

function normalizeWebhookUrl(u) {
  return String(u || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Compara la suscripcion guardada en Microsoft Graph con PUBLIC_API_BASE_URL actual.
 * Caso tipico: ngrok cambio de dominio y el .env no se actualizo / no se recreo la suscripcion.
 */
async function getWebhookDiagnostics(_userId, workspaceId) {
  const expectedNotificationUrl = normalizeWebhookUrl(
    `${String(env.publicApiBaseUrl || "").replace(/\/+$/, "")}/email/graph/webhook`
  );

  const rows = await prisma.emailGraphSubscription.findMany({
    where: { workspaceId },
    include: { workspace: true, integration: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const subscriptions = [];
  for (const sub of rows) {
    const tenantId = sub.workspace?.aadTenantId;
    const mailbox =
      sub.integration?.configJson &&
      typeof sub.integration.configJson === "object"
        ? sub.integration.configJson.mailbox
        : null;

    let graphRow = {
      graphOk: false,
      graphExpiresAt: null,
      graphNotificationUrl: null,
      graphResource: null,
      graphErrorMessage: null,
      graphErrorDetails: null,
    };

    try {
      const graph = await graphRequest(
        `/subscriptions/${sub.subscriptionId}`,
        { method: "GET" },
        { tenantId }
      );
      const graphUrl = graph.notificationUrl
        ? normalizeWebhookUrl(graph.notificationUrl)
        : null;
      graphRow = {
        graphOk: true,
        graphExpiresAt: graph.expirationDateTime || null,
        graphNotificationUrl: graph.notificationUrl || null,
        graphResource: graph.resource || null,
        graphErrorMessage: null,
        graphErrorDetails: null,
        urlMatchesExpected: Boolean(
          graphUrl && expectedNotificationUrl && graphUrl === expectedNotificationUrl
        ),
      };
    } catch (error) {
      graphRow = {
        graphOk: false,
        graphExpiresAt: null,
        graphNotificationUrl: null,
        graphResource: null,
        graphErrorMessage: error instanceof Error ? error.message : String(error),
        graphErrorDetails: error.details || null,
        urlMatchesExpected: false,
      };
    }

    subscriptions.push({
      localId: sub.id,
      subscriptionId: sub.subscriptionId,
      mailbox,
      resource: sub.resource,
      dbExpiresAt: sub.expirationDateTime,
      ...graphRow,
    });
  }

  return {
    publicApiBaseUrl: env.publicApiBaseUrl,
    expectedNotificationUrl: `${String(env.publicApiBaseUrl || "").replace(/\/+$/, "")}/email/graph/webhook`,
    kafkaEnabled: env.kafkaEnabled,
    hint:
      subscriptions.length === 0
        ? "No hay filas en EmailGraphSubscription. Volvé a Conectar buzón."
        : subscriptions.some((s) => !s.graphOk)
          ? "Graph no devolvio la suscripcion (vencida o borrada). Recreá la suscripcion."
          : subscriptions.every((s) => s.urlMatchesExpected)
            ? "La URL del webhook coincide con el .env. Si igual no llegan mails, revisa ngrok Inspector y GRAPH_WEBHOOK_LOG=true."
            : "La URL en Microsoft Graph NO coincide con tu .env. Actualiza PUBLIC_API_BASE_URL al ngrok actual y volvé a Conectar buzón (crea suscripcion nueva).",
    subscriptions,
  };
}

module.exports = {
  createGraphSubscription,
  listGraphSubscriptions,
  handleGraphNotification,
  diagnoseMailbox,
  getWebhookDiagnostics,
};
