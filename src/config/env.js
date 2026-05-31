/**
 * @file Carga, valida y expone la configuración del proceso a partir de
 * variables de entorno. La validación se hace con Zod en tiempo de arranque
 * para fallar rápido si algo está mal configurado.
 *
 * Convenciones:
 *  - Las variables booleanas se aceptan como `"true"`/`"false"` (case-insensitive).
 *  - Las listas (CSV) se parsean a arrays sin espacios y sin elementos vacíos.
 *  - Los defaults se aplican aquí, no en los consumidores, para tener un único
 *    "punto de verdad" de la configuración del backend.
 *
 * @module config/env
 */

const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

/**
 * Coerce de string a booleano según convención del proyecto.
 *
 * @param {string|undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBoolean(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/**
 * Coerce de CSV a array de strings, ignorando elementos vacíos.
 *
 * @param {string|undefined} value
 * @param {string[]} [defaultValue]
 * @returns {string[]}
 */
function parseCsv(value, defaultValue = []) {
  if (!value) return defaultValue.slice();
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  MSAL_TENANT_ID: z.string().min(1, "MSAL_TENANT_ID requerido"),
  MSAL_CLIENT_ID: z.string().min(1, "MSAL_CLIENT_ID requerido"),
  MSAL_CLIENT_SECRET: z.string().min(1, "MSAL_CLIENT_SECRET requerido"),
  MSAL_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/auth/callback"),
  MSAL_POST_LOGIN_REDIRECT_URI: z.string().url().default("http://localhost:3000"),
  MSAL_AUTH_SCOPES: z.string().default("openid profile email offline_access"),
  MSAL_ALLOWED_TENANT_IDS: z.string().optional(),
  MSAL_ALLOWED_AUDIENCES: z.string().optional(),

  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET debe tener al menos 16 caracteres"),
  SESSION_COOKIE_NAME: z.string().default("invoicely_session"),
  AUTH_FLOW_COOKIE_NAME: z.string().default("invoicely_auth_flow"),

  KAFKA_ENABLED: z.string().optional(),
  KAFKA_BROKERS: z.string().default("localhost:9092"),
  KAFKA_CLIENT_ID: z.string().default("invoicely-backend"),
  KAFKA_GROUP_ID: z.string().default("invoicely-email-workers"),
  KAFKA_EMAIL_TOPIC: z.string().default("email-processing-jobs"),
  KAFKA_EMAIL_RETRY_TOPIC: z.string().default("email-processing-jobs.retry"),
  KAFKA_EMAIL_DLQ_TOPIC: z.string().default("email-processing-jobs.dlq"),
  KAFKA_EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  /** Topic para jobs de envío a Business Central (un mensaje por `BcSyncEvent`). */
  KAFKA_BC_SYNC_TOPIC: z.string().default("parseva-bc-sync"),
  /** Consumer group dedicado (no reutilizar el de email). */
  KAFKA_BC_SYNC_GROUP_ID: z.string().default("parseva-bc-sync-workers"),
  /** DLQ opcional: fallos definitivos de sync BC (observabilidad / replay manual). */
  KAFKA_BC_SYNC_DLQ_TOPIC: z.string().default("parseva-bc-sync.dlq"),

  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:4000/api"),

  GRAPH_TENANT_ID: z.string().optional(),
  GRAPH_CLIENT_ID: z.string().optional(),
  GRAPH_CLIENT_SECRET: z.string().optional(),
  /** Renovar suscripciones Graph cada X ms (default 1 h; el worker corre en segundo plano). */
  GRAPH_RENEW_INTERVAL_MS: z.coerce.number().int().min(10_000).default(3_600_000),
  /**
   * Renovar si la suscripción vence dentro de esta ventana (default 48 h).
   * Así hay margen si el proceso estuvo caído un rato.
   */
  GRAPH_RENEW_BEFORE_MS: z.coerce.number().int().min(60_000).default(172_800_000),
  GRAPH_RENEW_WORKER_ENABLED: z.string().optional(),

  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_PDF_MODEL: z.string().optional(),
  OPENAI_NATIVE_PDF: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBEDDING_DIMS: z.coerce.number().int().min(32).max(3072).default(1536),
  EMBEDDING_MAX_CHARS: z.coerce.number().int().min(500).max(32_000).default(8000),

  AZURE_DI_ENDPOINT: z.string().url().optional().default(""),
  AZURE_DI_KEY: z.string().optional().default(""),
  AZURE_DI_API_VERSION: z.string().default("2024-11-30"),
  AZURE_DI_MODEL_ID: z.string().default("prebuilt-layout"),
  AZURE_DI_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(1500),
  AZURE_DI_MAX_POLL_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),

  FLOW_WORKER_ENABLED: z.string().optional(),
  FLOW_WORKER_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  FLOW_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  /** Sin integración BC configurada: si true, el worker simula éxito (solo desarrollo). */
  BC_ERP_USE_MOCK: z.string().optional(),
  BC_ERP_TIMEOUT_MS: z.coerce.number().int().min(3000).max(120000).default(60000),

  /**
   * App Entra multi-inquilino Parseva: client credentials contra el tenant del
   * cliente (ver integration business_central). Vacío = solo override por workspace o Bearer manual.
   */
  BC_CONNECTOR_CLIENT_ID: z.string().optional().default(""),
  BC_CONNECTOR_CLIENT_SECRET: z.string().optional().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Variables de entorno inválidas:\n${issues}`);
}

const raw = parsed.data;

/**
 * @typedef {object} AppEnv
 * @property {number} port
 * @property {"development"|"test"|"production"} nodeEnv
 * @property {string} msalTenantId
 * @property {string} msalClientId
 * @property {string} msalClientSecret
 * @property {string} msalRedirectUri
 * @property {string} msalPostLoginRedirectUri
 * @property {string[]} msalAuthScopes
 * @property {string[]} msalAllowedTenantIds
 * @property {string[]} msalAllowedAudiences
 * @property {string} frontendOrigin
 * @property {string} sessionSecret
 * @property {string} sessionCookieName
 * @property {string} authFlowCookieName
 * @property {boolean} kafkaEnabled
 * @property {string[]} kafkaBrokers
 * @property {string} kafkaClientId
 * @property {string} kafkaGroupId
 * @property {string} kafkaEmailTopic
 * @property {string} kafkaEmailRetryTopic
 * @property {string} kafkaEmailDlqTopic
 * @property {number} kafkaEmailMaxAttempts
 * @property {string} kafkaBcSyncTopic
 * @property {string} kafkaBcSyncGroupId
 * @property {string} kafkaBcSyncDlqTopic
 * @property {string} publicApiBaseUrl
 * @property {string} graphTenantId
 * @property {string} graphClientId
 * @property {string} graphClientSecret
 * @property {number} graphRenewIntervalMs
 * @property {number} graphRenewBeforeMs
 * @property {boolean} graphRenewWorkerEnabled
 * @property {string} openaiApiKey
 * @property {string} openaiModel
 * @property {string} openaiPdfModel
 * @property {boolean} openaiNativePdfEnabled
 * @property {string} openaiEmbeddingModel
 * @property {number} openaiEmbeddingDims
 * @property {number} embeddingMaxChars
 * @property {string} azureDiEndpoint
 * @property {string} azureDiKey
 * @property {string} azureDiApiVersion
 * @property {string} azureDiModelId
 * @property {number} azureDiPollIntervalMs
 * @property {number} azureDiMaxPollMs
 * @property {boolean} flowWorkerEnabled
 * @property {number} flowWorkerPollMs
 * @property {number} flowWorkerBatchSize
 * @property {string} bcConnectorClientId
 * @property {string} bcConnectorClientSecret
 */

/** @type {AppEnv} */
const env = Object.freeze({
  port: raw.PORT,
  nodeEnv: raw.NODE_ENV,

  msalTenantId: raw.MSAL_TENANT_ID,
  msalClientId: raw.MSAL_CLIENT_ID,
  msalClientSecret: raw.MSAL_CLIENT_SECRET,
  msalRedirectUri: raw.MSAL_REDIRECT_URI,
  msalPostLoginRedirectUri: raw.MSAL_POST_LOGIN_REDIRECT_URI,
  msalAuthScopes: raw.MSAL_AUTH_SCOPES.split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean),
  msalAllowedTenantIds: parseCsv(raw.MSAL_ALLOWED_TENANT_IDS),
  msalAllowedAudiences: parseCsv(raw.MSAL_ALLOWED_AUDIENCES, [raw.MSAL_CLIENT_ID]),

  frontendOrigin: raw.FRONTEND_ORIGIN,
  sessionSecret: raw.SESSION_SECRET,
  sessionCookieName: raw.SESSION_COOKIE_NAME,
  authFlowCookieName: raw.AUTH_FLOW_COOKIE_NAME,

  kafkaEnabled: parseBoolean(raw.KAFKA_ENABLED, false),
  kafkaBrokers: parseCsv(raw.KAFKA_BROKERS, ["localhost:9092"]),
  kafkaClientId: raw.KAFKA_CLIENT_ID,
  kafkaGroupId: raw.KAFKA_GROUP_ID,
  kafkaEmailTopic: raw.KAFKA_EMAIL_TOPIC,
  kafkaEmailRetryTopic: raw.KAFKA_EMAIL_RETRY_TOPIC,
  kafkaEmailDlqTopic: raw.KAFKA_EMAIL_DLQ_TOPIC,
  kafkaEmailMaxAttempts: raw.KAFKA_EMAIL_MAX_ATTEMPTS,

  kafkaBcSyncTopic: raw.KAFKA_BC_SYNC_TOPIC,
  kafkaBcSyncGroupId: raw.KAFKA_BC_SYNC_GROUP_ID,
  kafkaBcSyncDlqTopic: raw.KAFKA_BC_SYNC_DLQ_TOPIC,

  publicApiBaseUrl: raw.PUBLIC_API_BASE_URL,

  graphTenantId: raw.GRAPH_TENANT_ID || raw.MSAL_TENANT_ID,
  graphClientId: raw.GRAPH_CLIENT_ID || raw.MSAL_CLIENT_ID,
  graphClientSecret: raw.GRAPH_CLIENT_SECRET || raw.MSAL_CLIENT_SECRET,
  graphRenewIntervalMs: raw.GRAPH_RENEW_INTERVAL_MS,
  graphRenewBeforeMs: raw.GRAPH_RENEW_BEFORE_MS,
  graphRenewWorkerEnabled: parseBoolean(raw.GRAPH_RENEW_WORKER_ENABLED, true),

  openaiApiKey: raw.OPENAI_API_KEY,
  openaiModel: raw.OPENAI_MODEL,
  openaiPdfModel: raw.OPENAI_PDF_MODEL || raw.OPENAI_MODEL,
  openaiNativePdfEnabled: parseBoolean(raw.OPENAI_NATIVE_PDF, true),
  openaiEmbeddingModel: raw.OPENAI_EMBEDDING_MODEL,
  openaiEmbeddingDims: raw.OPENAI_EMBEDDING_DIMS,
  embeddingMaxChars: raw.EMBEDDING_MAX_CHARS,

  azureDiEndpoint: raw.AZURE_DI_ENDPOINT.replace(/\/+$/, ""),
  azureDiKey: raw.AZURE_DI_KEY,
  azureDiApiVersion: raw.AZURE_DI_API_VERSION,
  azureDiModelId: raw.AZURE_DI_MODEL_ID,
  azureDiPollIntervalMs: raw.AZURE_DI_POLL_INTERVAL_MS,
  azureDiMaxPollMs: raw.AZURE_DI_MAX_POLL_MS,

  flowWorkerEnabled: parseBoolean(raw.FLOW_WORKER_ENABLED, true),
  flowWorkerPollMs: raw.FLOW_WORKER_POLL_MS,
  flowWorkerBatchSize: raw.FLOW_WORKER_BATCH_SIZE,

  bcErpUseMock: parseBoolean(raw.BC_ERP_USE_MOCK, raw.NODE_ENV !== "production"),
  bcErpTimeoutMs: raw.BC_ERP_TIMEOUT_MS,

  bcConnectorClientId: (raw.BC_CONNECTOR_CLIENT_ID || "").trim(),
  bcConnectorClientSecret: (raw.BC_CONNECTOR_CLIENT_SECRET || "").trim(),
});

module.exports = env;
