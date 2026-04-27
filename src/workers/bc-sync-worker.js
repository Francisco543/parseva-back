/**
 * @file Worker periódico que procesa eventos pendientes de sync con Business Central.
 * Recorre todos los workspaces y delega en `processPendingBcSync`.
 *
 * @module workers/bc-sync-worker
 */

const prisma = require("../lib/prisma");
const env = require("../config/env");
const { processPendingBcSync } = require("../services/bc-sync.service");
const { logger } = require("../lib/logger");

let timer = null;

/**
 * Procesa una tanda de eventos pendientes para todos los workspaces.
 * No lanza: cualquier error queda registrado en logs.
 *
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
      "tick failed"
    );
  }
}

/**
 * Arranca el loop periódico (si `FLOW_WORKER_ENABLED=true`).
 *
 * @returns {void}
 */
function startBcSyncWorker() {
  if (!env.flowWorkerEnabled) {
    logger.info(
      { component: "bc-sync-worker" },
      "deshabilitado (FLOW_WORKER_ENABLED=false)"
    );
    return;
  }

  void tick();
  timer = setInterval(() => {
    void tick();
  }, Math.max(1000, env.flowWorkerPollMs));

  logger.info(
    { component: "bc-sync-worker", pollMs: env.flowWorkerPollMs },
    "iniciado"
  );
}

/**
 * Detiene el loop (para graceful shutdown).
 *
 * @returns {void}
 */
function stopBcSyncWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startBcSyncWorker,
  stopBcSyncWorker,
};
