/**
 * @file Cliente Kafka opcional para encolar jobs de procesamiento de emails.
 *
 * Si `KAFKA_ENABLED=false` (o no está configurado) este módulo se vuelve un
 * conjunto de funciones no-op: las publicaciones devuelven `false` y los consumers
 * no arrancan. Esto permite que el procesamiento de correos se haga "inline" en
 * desarrollo sin necesidad de un broker.
 *
 * Topics usados:
 *  - `KAFKA_EMAIL_TOPIC`: cola principal de jobs de email.
 *  - `KAFKA_EMAIL_RETRY_TOPIC`: jobs con `notBefore` futuro a re-publicar.
 *  - `KAFKA_EMAIL_DLQ_TOPIC`: dead letter queue para jobs fallidos definitivos.
 *
 * @module lib/kafka
 */

const { Kafka } = require("kafkajs");
const env = require("../config/env");

/** @type {import('kafkajs').Producer | undefined} */
let producer;
/** @type {import('kafkajs').Consumer | undefined} */
let mainConsumer;
/** @type {import('kafkajs').Consumer | undefined} */
let retryConsumer;
/** @type {Kafka | undefined} */
let kafkaClient;

/**
 * Indica si Kafka está habilitado por configuración.
 *
 * @returns {boolean}
 */
function isKafkaEnabled() {
  return env.kafkaEnabled;
}

/**
 * Devuelve (creando si es necesario) la instancia singleton del cliente Kafka.
 *
 * @returns {Kafka}
 */
function getKafkaClient() {
  if (!kafkaClient) {
    kafkaClient = new Kafka({
      clientId: env.kafkaClientId,
      brokers: env.kafkaBrokers,
    });
  }
  return kafkaClient;
}

/**
 * Devuelve el producer conectado, o `null` si Kafka está deshabilitado.
 *
 * @returns {Promise<import('kafkajs').Producer | null>}
 */
async function getProducer() {
  if (!isKafkaEnabled()) return null;
  if (!producer) {
    producer = getKafkaClient().producer();
    await producer.connect();
  }
  return producer;
}

/**
 * @typedef {object} EmailJobPayload
 * @property {string} jobId Identificador único del job (`EmailJob.id`).
 * @property {string} userId
 * @property {string} workspaceId
 * @property {string} emailMessageId
 * @property {number} [notBefore] Epoch ms mínimo a esperar antes de re-procesar.
 * @property {string} [retryFrom]
 * @property {string|null} [scheduledAt]
 */

/**
 * Publica un job en el topic principal de emails.
 *
 * @param {EmailJobPayload} jobPayload
 * @returns {Promise<boolean>} `true` si se publicó, `false` si Kafka está deshabilitado.
 */
async function publishEmailJob(jobPayload) {
  const activeProducer = await getProducer();
  if (!activeProducer) return false;

  await activeProducer.send({
    topic: env.kafkaEmailTopic,
    messages: [{ value: JSON.stringify(jobPayload) }],
  });
  return true;
}

/**
 * Publica un job en el topic de retry (lo recogerá `startEmailRetryConsumer`).
 *
 * @param {EmailJobPayload} jobPayload
 * @returns {Promise<boolean>}
 */
async function publishEmailRetry(jobPayload) {
  const activeProducer = await getProducer();
  if (!activeProducer) return false;

  await activeProducer.send({
    topic: env.kafkaEmailRetryTopic,
    messages: [{ value: JSON.stringify(jobPayload) }],
  });
  return true;
}

/**
 * Publica un job en la dead letter queue.
 *
 * @param {EmailJobPayload & { error?: string }} jobPayload
 * @returns {Promise<boolean>}
 */
async function publishEmailDlq(jobPayload) {
  const activeProducer = await getProducer();
  if (!activeProducer) return false;

  await activeProducer.send({
    topic: env.kafkaEmailDlqTopic,
    messages: [{ value: JSON.stringify(jobPayload) }],
  });
  return true;
}

/**
 * Inicia el consumer del topic principal y delega cada mensaje en `onMessage`.
 * Es idempotente: si ya hay un consumer corriendo no hace nada.
 *
 * @param {(payload: EmailJobPayload) => Promise<void>} onMessage
 * @returns {Promise<void>}
 */
async function startEmailConsumer(onMessage) {
  if (!isKafkaEnabled()) return;
  if (mainConsumer) return;

  mainConsumer = getKafkaClient().consumer({ groupId: env.kafkaGroupId });
  await mainConsumer.connect();
  await mainConsumer.subscribe({ topic: env.kafkaEmailTopic, fromBeginning: false });
  await mainConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const payload = JSON.parse(message.value.toString());
      await onMessage(payload);
    },
  });
}

/**
 * Consumer de retry: lee mensajes con `notBefore` y los re-publica al topic
 * principal cuando vence el plazo. No bloquea el consumer: programa con
 * `setTimeout` y confirma el offset inmediatamente.
 *
 * @returns {Promise<void>}
 */
async function startEmailRetryConsumer() {
  if (!isKafkaEnabled()) return;
  if (retryConsumer) return;

  retryConsumer = getKafkaClient().consumer({ groupId: `${env.kafkaGroupId}-retry` });
  await retryConsumer.connect();
  await retryConsumer.subscribe({ topic: env.kafkaEmailRetryTopic, fromBeginning: false });
  await retryConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const payload = JSON.parse(message.value.toString());
      const notBefore = Number(payload?.notBefore || 0);
      const now = Date.now();
      const delay = Math.max(0, notBefore - now);

      setTimeout(() => {
        publishEmailJob({
          jobId: payload.jobId,
          userId: payload.userId,
          workspaceId: payload.workspaceId,
          emailMessageId: payload.emailMessageId,
          retryFrom: "kafka",
          scheduledAt: payload.scheduledAt || null,
        }).catch(() => {});
      }, delay);
    },
  });
}

/**
 * Cierra ordenadamente producer y consumers de Kafka. Se utiliza durante el
 * shutdown del servidor. Es seguro llamarlo aunque Kafka esté deshabilitado.
 *
 * @returns {Promise<void>}
 */
async function disconnectKafka() {
  const tasks = [];
  if (mainConsumer) tasks.push(mainConsumer.disconnect().catch(() => {}));
  if (retryConsumer) tasks.push(retryConsumer.disconnect().catch(() => {}));
  if (producer) tasks.push(producer.disconnect().catch(() => {}));
  await Promise.allSettled(tasks);
  mainConsumer = undefined;
  retryConsumer = undefined;
  producer = undefined;
}

module.exports = {
  isKafkaEnabled,
  publishEmailJob,
  publishEmailRetry,
  publishEmailDlq,
  startEmailConsumer,
  startEmailRetryConsumer,
  disconnectKafka,
};
