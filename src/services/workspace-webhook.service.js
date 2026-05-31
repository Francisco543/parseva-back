/**
 * Webhooks salientes por workspace.
 *
 * @module services/workspace-webhook
 */

const crypto = require("node:crypto");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

async function listOutgoingWebhooks(workspaceId) {
  return prisma.outgoingWebhook.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      events: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * @param {string} workspaceId
 * @param {{ url: string, secret?: string, events?: string[], enabled?: boolean }} input
 */
async function createOutgoingWebhook(workspaceId, input) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url.startsWith("https://") && !url.startsWith("http://localhost")) {
    throw new HttpError(400, "La URL debe usar HTTPS (excepto localhost)");
  }
  const secret =
    typeof input.secret === "string" && input.secret.length >= 16
      ? input.secret
      : crypto.randomBytes(24).toString("hex");
  const events = Array.isArray(input.events) ? input.events.map((e) => String(e)) : ["document.needs_review"];

  return prisma.outgoingWebhook.create({
    data: {
      workspaceId,
      url,
      secret,
      events,
      enabled: input.enabled !== false,
    },
    select: {
      id: true,
      url: true,
      secret: true,
      events: true,
      enabled: true,
      createdAt: true,
    },
  });
}

async function deleteOutgoingWebhook(workspaceId, id) {
  const row = await prisma.outgoingWebhook.findFirst({
    where: { id, workspaceId },
  });
  if (!row) throw new HttpError(404, "Webhook no encontrado");
  await prisma.outgoingWebhook.delete({ where: { id } });
}

module.exports = {
  listOutgoingWebhooks,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
};
