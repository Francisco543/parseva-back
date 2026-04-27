/**
 * @file Logger estructurado (JSON) basado en pino para todo el backend.
 *
 * Reglas:
 *  - El nivel se controla con la env `LOG_LEVEL` (default: `info`).
 *  - Nunca se loggean tokens/secretos: las cabeceras de auth y cookies se
 *    eliminan antes de serializar.
 *  - Cada módulo debe pasar `component` en la metadata para facilitar el filtrado.
 *
 * @module lib/logger
 *
 * @example
 *   const { logger } = require("../lib/logger");
 *   logger.info({ component: "email-worker", jobId }, "procesando job");
 */

const pino = require("pino");

const level = process.env.LOG_LEVEL || "info";

const logger = pino({
  level,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.access_token",
      "req.body.refresh_token",
    ],
    remove: true,
  },
});

module.exports = {
  logger,
};
