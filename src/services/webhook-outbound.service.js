/**
 * Entrega webhooks HTTP firmados (HMAC-SHA256) para integraciones externas.
 *
 * @module services/webhook-outbound
 */

const crypto = require("node:crypto");

const prisma = require("../lib/prisma");
const { logger } = require("../lib/logger");

/**
 * @param {string} workspaceId
 * @param {string} event
 * @param {Record<string, unknown>} payload
 */
async function dispatchOutgoingWebhooks(workspaceId, event, payload) {
  try {
    const hooks = await prisma.outgoingWebhook.findMany({
      where: { workspaceId, enabled: true },
    });
    for (const h of hooks) {
      let events = [];
      try {
        const ev = h.events;
        if (Array.isArray(ev)) events = ev.map((x) => String(x));
        else if (ev && typeof ev === "object") events = [];
      } catch {
        events = [];
      }
      if (!events.includes(event) && !events.includes("*")) continue;

      const body = JSON.stringify({
        event,
        payload,
        ts: new Date().toISOString(),
      });
      const sig = crypto.createHmac("sha256", h.secret).update(body).digest("hex");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      fetch(h.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Parseva-Signature": sig,
          "X-Parseva-Event": event,
        },
        body,
        signal: ac.signal,
      })
        .catch((err) => {
          logger.warn(
            { component: "webhook-outbound", err: String(err), url: h.url },
            "webhook delivery failed"
          );
        })
        .finally(() => clearTimeout(timer));
    }
  } catch (e) {
    logger.warn({ component: "webhook-outbound", err: String(e) }, "dispatch failed");
  }
}

module.exports = {
  dispatchOutgoingWebhooks,
};
