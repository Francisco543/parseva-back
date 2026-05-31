/**
 * @file Renueva por PATCH las suscripciones Microsoft Graph de correo próximas a vencer.
 *
 * Corre en intervalos (`GRAPH_RENEW_INTERVAL_MS`) y extiende cada una hasta la duración
 * máxima permitida por Graph (`OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS`, ~7 días para mensajes).
 * No requiere intervención del usuario mientras el proceso API siga en ejecución.
 *
 * @module workers/graph-subscription-renewal
 */

const prisma = require("../lib/prisma");
const env = require("../config/env");
const { graphRequest } = require("../lib/graph-client");
const { logger } = require("../lib/logger");
const HttpError = require("../utils/http-error");
const {
  OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS,
} = require("../constants/graph-subscription");

let timer = null;
let running = false;

/**
 * graphFetch envuelve errores Graph como HttpError 502 con el body en `details`.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function graphErrorIndicatesMissingSubscription(error) {
  if (!(error instanceof HttpError)) return false;
  const raw = error.details;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  if (/resourceNotFound/i.test(text) || /"code"\s*:\s*"ResourceNotFound"/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Renueva suscripciones cuya `expirationDateTime` cae dentro de la ventana
 * [ahora, ahora + GRAPH_RENEW_BEFORE_MS] (incluye ya vencidas).
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

    if (expiring.length === 0) return;

    const nextExpiration = new Date(Date.now() + OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS);
    let ok = 0;
    let failed = 0;

    for (const subscription of expiring) {
      const tenantId = subscription.workspace?.aadTenantId;
      if (!tenantId) {
        logger.warn(
          {
            component: "graph-renewal",
            localId: subscription.id,
          },
          "skip: workspace sin aadTenantId"
        );
        failed += 1;
        continue;
      }

      try {
        const response = await graphRequest(
          `/subscriptions/${subscription.subscriptionId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              expirationDateTime: nextExpiration.toISOString(),
            }),
          },
          { tenantId }
        );

        await prisma.emailGraphSubscription.update({
          where: { id: subscription.id },
          data: {
            expirationDateTime: new Date(response.expirationDateTime),
          },
        });
        ok += 1;
      } catch (error) {
        failed += 1;
        const isNotFound = graphErrorIndicatesMissingSubscription(error);
        if (isNotFound) {
          try {
            await prisma.emailGraphSubscription.delete({ where: { id: subscription.id } });
          } catch {
            /* ignore */
          }
          logger.warn(
            {
              component: "graph-renewal",
              subscriptionId: subscription.subscriptionId,
            },
            "Graph devolvió 404; fila local eliminada (recrear suscripción en la app)"
          );
        } else {
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
    }

    logger.info(
      {
        component: "graph-renewal",
        scanned: expiring.length,
        renewed: ok,
        failed,
      },
      "ciclo renovación Graph"
    );
  } finally {
    running = false;
  }
}

/**
 * Arranca el worker periódico (si `GRAPH_RENEW_WORKER_ENABLED` no es false).
 *
 * @returns {void}
 */
function startGraphRenewalWorker() {
  if (!env.graphRenewWorkerEnabled) {
    logger.info({ component: "graph-renewal" }, "worker deshabilitado (GRAPH_RENEW_WORKER_ENABLED=false)");
    return;
  }
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
