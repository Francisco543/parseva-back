/**
 * @file Worker que consume jobs de procesamiento de emails desde Kafka.
 * Si Kafka está deshabilitado, el procesamiento se hace inline en `ingestEmailEvent`.
 *
 * @module workers/email-worker
 */

const {
  startEmailConsumer,
  startEmailRetryConsumer,
  isKafkaEnabled,
} = require("../lib/kafka");
const { processEmailJob } = require("../services/email-automation.service");
const { logger } = require("../lib/logger");

/**
 * Inicializa los consumers de Kafka (principal + retry).
 *
 * @returns {Promise<void>}
 */
async function startEmailWorker() {
  if (!isKafkaEnabled()) {
    logger.info({ component: "email-worker" }, "Kafka deshabilitado: procesamiento inline");
    return;
  }

  await startEmailRetryConsumer();
  await startEmailConsumer(async (payload) => {
    await processEmailJob(payload);
  });

  logger.info({ component: "email-worker" }, "Suscripto al topic principal de Kafka");
}

module.exports = {
  startEmailWorker,
};
