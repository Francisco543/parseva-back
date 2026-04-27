/**
 * @file Renueva las suscripciones de Microsoft Graph que estén próximas a vencer.
 *
 * Las suscripciones de Graph (mailbox webhook) tienen un TTL máximo de ~1 hora.
 * Este worker corre en intervalos y extiende las que están dentro de la ventana
 * de renovación (`GRAPH_RENEW_BEFORE_MS`).
 *
 * @module workers/graph-subscription-renewal
 */

const prisma = require("../lib/prisma");
const env = require("../config/env");
const { graphRequest } = require("../lib/graph-client");
const { logger } = require("../lib/logger");

let timer = null;
let running = false;

/**
 * Renueva todas las suscripciones que vayan a vencer dentro de `GRAPH_RENEW_BEFORE_MS`.
 *
 * Reentrante-safe: si ya hay una iteración corriendo, esta llamada se ignora.
 *
 * @returns {Promise<void>}
 */
async function renewExpiringSubscriptions() {
  if (running) return;
  running = true;
  try {
    const threshold = new Date(Date.now() + env.graphRenewBeforeMs);
    const expiring = await prisma.emailGraphSubscription.findMany({
      where: { expirationDateTime: { lte: threshold } },
      include: { workspace: true },
      take: 100,
    });

    for (const subscription of expiring) {
      const nextExpiration = new Date(Date.now() + 60 * 60 * 1000);
      try {
        const response = await graphRequest(
          `/subscriptions/${subscription.subscriptionId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              expirationDateTime: nextExpiration.toISOString(),
            }),
          },
          { tenantId: subscription.workspace?.aadTenantId }
        );

        await prisma.emailGraphSubscription.update({
          where: { id: subscription.id },
          data: {
            expirationDateTime: new Date(response.expirationDateTime),
          },
        });
      } catch (error) {
        logger.warn(
          {
            component: "graph-renewal",
            subscriptionId: subscription.subscriptionId,
            err: error instanceof Error ? error.message : String(error),
          },
          "renew failed (se reintenta en el próximo ciclo)"
        );
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Arranca el worker periódico.
 *
 * @returns {void}
 */
function startGraphRenewalWorker() {
  if (timer) return;
  timer = setInterval(() => {
    renewExpiringSubscriptions().catch((err) => {
      logger.error(
        {
          component: "graph-renewal",
          err: err instanceof Error ? err.message : String(err),
        },
        "tick failed"
      );
    });
  }, env.graphRenewIntervalMs);
}

/**
 * Detiene el worker (para graceful shutdown).
 *
 * @returns {void}
 */
function stopGraphRenewalWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startGraphRenewalWorker,
  stopGraphRenewalWorker,
  renewExpiringSubscriptions,
};
