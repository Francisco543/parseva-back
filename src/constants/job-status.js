/**
 * @file Estados de `ProcessingJob` (cola interna de procesamiento de correos).
 *
 * @module constants/job-status
 */

/**
 * @typedef {(typeof JOB_STATUS)[keyof typeof JOB_STATUS]} JobStatus
 */
const JOB_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

/**
 * Identificadores estables de cola lógica (`ProcessingJob.queueKey`).
 *
 * @typedef {(typeof QUEUE_KEY)[keyof typeof QUEUE_KEY]} QueueKey
 */
const QUEUE_KEY = Object.freeze({
  EMAIL_INGESTION: "email-ingestion",
});

module.exports = {
  JOB_STATUS,
  QUEUE_KEY,
};
