/**
 * @file Punto de entrada del servidor HTTP de Invoicely.
 *
 * Responsabilidades:
 *  - Levantar el servidor Express en el puerto configurado.
 *  - Arrancar los workers (email, renovación de suscripciones Graph, sync BC).
 *  - Registrar handlers de cierre ordenado (`SIGTERM`/`SIGINT`) para detener
 *    intervalos, drenar Kafka (si está habilitado) y cerrar Prisma sin perder
 *    procesamientos en curso.
 *
 * @module server
 */

const env = require("./config/env");
const app = require("./app");
const prisma = require("./lib/prisma");
const { logger } = require("./lib/logger");
const { disconnectKafka } = require("./lib/kafka");
const { startEmailWorker } = require("./workers/email-worker");
const {
  startGraphRenewalWorker,
  stopGraphRenewalWorker,
  renewExpiringSubscriptions,
} = require("./workers/graph-subscription-renewal.worker");
const { startBcSyncWorker, stopBcSyncWorker } = require("./workers/bc-sync-worker");

const server = app.listen(env.port, () => {
  const base = String(env.publicApiBaseUrl || "").replace(/\/+$/, "");
  logger.info(
    {
      component: "server",
      port: env.port,
      graphWebhook: `${base}/email/graph/webhook`,
    },
    `API escuchando en http://localhost:${env.port}`
  );
});

startEmailWorker().catch((error) => {
  logger.error(
    {
      component: "email-worker",
      err: error instanceof Error ? error.message : String(error),
    },
    "no se pudo iniciar el worker de email"
  );
});

if (env.graphRenewWorkerEnabled) {
  startGraphRenewalWorker();
  setImmediate(() => {
    renewExpiringSubscriptions().catch((err) => {
      logger.error(
        {
          component: "graph-renewal",
          err: err instanceof Error ? err.message : String(err),
        },
        "primer ciclo de renovación Graph falló"
      );
    });
  });
}
startBcSyncWorker();

/**
 * Cierra ordenadamente el servidor liberando recursos:
 *  1. Frena los timers (workers de polling).
 *  2. Cierra el listener HTTP para no aceptar nuevas conexiones.
 *  3. Desconecta Kafka y Prisma.
 *
 * Se fuerza la salida del proceso si tarda más de `SHUTDOWN_FORCE_MS`.
 *
 * @param {NodeJS.Signals|"manual"} signal
 * @returns {Promise<void>}
 */
async function gracefulShutdown(signal) {
  const SHUTDOWN_FORCE_MS = 10_000;
  const forceTimer = setTimeout(() => {
    logger.error({ component: "server", signal }, "shutdown forzado por timeout");
    process.exit(1);
  }, SHUTDOWN_FORCE_MS);
  forceTimer.unref();

  logger.info({ component: "server", signal }, "iniciando shutdown ordenado");

  try {
    stopGraphRenewalWorker();
    stopBcSyncWorker();

    await new Promise((resolve) => server.close(() => resolve()));

    await Promise.allSettled([disconnectKafka(), prisma.$disconnect()]);

    logger.info({ component: "server" }, "shutdown completado");
    process.exit(0);
  } catch (error) {
    logger.error(
      {
        component: "server",
        err: error instanceof Error ? error.message : String(error),
      },
      "error durante shutdown"
    );
    process.exit(1);
  }
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error(
    {
      component: "server",
      err: reason instanceof Error ? reason.message : String(reason),
    },
    "unhandled promise rejection"
  );
});

process.on("uncaughtException", (error) => {
  logger.fatal(
    {
      component: "server",
      err: error instanceof Error ? error.message : String(error),
    },
    "uncaught exception"
  );
  gracefulShutdown("manual").catch(() => process.exit(1));
});
