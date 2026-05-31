/**
 * @file Despacho de sync con Business Central.
 *
 * - Con `KAFKA_ENABLED=true`: consumer dedicado (`KAFKA_BC_SYNC_TOPIC`) — un
 *   mensaje por `BcSyncEvent`; sin polling duplicado.
 * - Con Kafka desactivado: polling periódico (`FLOW_WORKER_*`) que procesa
 *   eventos `PENDING` vía `processPendingBcSync`.
 *
 * @module workers/bc-sync-worker
 */

const prisma = require("../lib/prisma");
const env = require("../config/env");
const { processPendingBcSync, processBcSyncEventById } = require("../services/bc-sync.service");
const { isKafkaEnabled, startBcSyncConsumer, stopBcSyncConsumer } = require("../lib/kafka");
const { logger } = require("../lib/logger");

let timer = null;

/**
 * @returns {Promise<void>}
 */
async function tick() {
  try {
    const workspaces = await prisma.workspace.findMany({ select: { id: true } });
    for (const ws of workspaces) {
      await processPendingBcSync(ws.id, env.flowWorkerBatchSize);
    }
  } catch (error) {
    logger.error(
      {
        component: "bc-sync-worker",
        err: error instanceof Error ? error.message : String(error),
      },
      "tick failed",
    );
  }
}

/**
 * Arranca consumer Kafka o el loop de polling (mutuamente excluyentes).
 *
 * @returns {void}
 */
function startBcSyncWorker() {
  if (isKafkaEnabled()) {
    void startBcSyncConsumer(async (payload) => {
      try {
        await processBcSyncEventById(payload.workspaceId, payload.eventId);
      } catch (error) {
        logger.error(
          {
            component: "bc-sync-kafka",
            err: error instanceof Error ? error.message : String(error),
            eventId: payload.eventId,
            workspaceId: payload.workspaceId,
          },
          "error al procesar mensaje BC sync",
        );
      }
    }).catch((error) => {
      logger.error(
        {
          component: "bc-sync-worker",
          err: error instanceof Error ? error.message : String(error),
        },
        "no se pudo iniciar consumer Kafka para BC sync",
      );
    });
    logger.info(
      {
        component: "bc-sync-worker",
        mode: "kafka",
        topic: env.kafkaBcSyncTopic,
        groupId: env.kafkaBcSyncGroupId,
      },
      "BC sync: consumer Kafka activo",
    );
    return;
  }

  if (!env.flowWorkerEnabled) {
    logger.info(
      { component: "bc-sync-worker" },
      "Kafka deshabilitado y FLOW_WORKER_ENABLED=false: no hay despacho BC automático",
    );
    return;
  }

  void tick();
  timer = setInterval(() => {
    void tick();
  }, Math.max(1000, env.flowWorkerPollMs));

  logger.info(
    { component: "bc-sync-worker", mode: "polling", pollMs: env.flowWorkerPollMs },
    "BC sync: worker de polling activo",
  );
}

/**
 * @returns {void}
 */
function stopBcSyncWorker() {
  void stopBcSyncConsumer().catch(() => {});
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startBcSyncWorker,
  stopBcSyncWorker,
};
