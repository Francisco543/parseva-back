/**
 * @file Estados del ciclo de vida de un documento procesado por la automatización.
 *
 * El flujo típico es:
 *   RECEIVED → CLASSIFIED → ARCHIVED → EXTRACTED → NEEDS_APPROVAL → ERP_QUEUED → ERP_SYNCED
 *
 * Estados terminales en error: NEEDS_REVIEW, FAILED, REJECTED.
 *
 * Estos valores se persisten como string en `DocumentRecord.status`, por lo que
 * **no** deben renombrarse sin una migración de datos.
 *
 * @module constants/document-status
 */

/**
 * @typedef {(typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS]} DocumentStatus
 */

const DOCUMENT_STATUS = Object.freeze({
  RECEIVED: "RECEIVED",
  CLASSIFIED: "CLASSIFIED",
  ARCHIVED: "ARCHIVED",
  EXTRACTED: "EXTRACTED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  NEEDS_APPROVAL: "NEEDS_APPROVAL",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  ERP_QUEUED: "ERP_QUEUED",
  ERP_SYNCED: "ERP_SYNCED",
  FAILED: "FAILED",
});

/**
 * Estado de un `EmailMessage`.
 *
 * @typedef {(typeof EMAIL_STATUS)[keyof typeof EMAIL_STATUS]} EmailStatus
 */
const EMAIL_STATUS = Object.freeze({
  RECEIVED: "RECEIVED",
  ANALYZED: "ANALYZED",
  ARCHIVED: "ARCHIVED",
  IGNORED: "IGNORED",
});

/**
 * Estado de una `ApprovalRequest`.
 *
 * @typedef {(typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS]} ApprovalStatus
 */
const APPROVAL_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

module.exports = {
  DOCUMENT_STATUS,
  EMAIL_STATUS,
  APPROVAL_STATUS,
};
