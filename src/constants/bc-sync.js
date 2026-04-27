/**
 * @file Constantes para la sincronización con Business Central.
 *
 * @module constants/bc-sync
 */

/**
 * Estados de un `BcSyncEvent`.
 *
 * @typedef {(typeof BC_SYNC_STATUS)[keyof typeof BC_SYNC_STATUS]} BcSyncStatus
 */
const BC_SYNC_STATUS = Object.freeze({
  PENDING: "PENDING",
  SENT: "SENT",
  SYNCED: "SYNCED",
  FAILED: "FAILED",
});

/**
 * Modo de un `BcTarget`.
 *
 * @typedef {(typeof BC_TARGET_MODE)[keyof typeof BC_TARGET_MODE]} BcTargetMode
 */
const BC_TARGET_MODE = Object.freeze({
  CURATED: "CURATED",
  EXTENSION: "EXTENSION",
});

/**
 * Estados de aprobación de extensiones a tablas de BC.
 *
 * @typedef {(typeof BC_EXTENSION_STATUS)[keyof typeof BC_EXTENSION_STATUS]} BcExtensionStatus
 */
const BC_EXTENSION_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

/**
 * Modos de sincronización a Business Central por tipo documental.
 *
 * @typedef {(typeof BC_SYNC_MODE)[keyof typeof BC_SYNC_MODE]} BcSyncMode
 */
const BC_SYNC_MODE = Object.freeze({
  MANUAL: "MANUAL",
  AFTER_APPROVAL: "AFTER_APPROVAL",
  AUTO_IF_CONFIDENT: "AUTO_IF_CONFIDENT",
});

module.exports = {
  BC_SYNC_STATUS,
  BC_TARGET_MODE,
  BC_EXTENSION_STATUS,
  BC_SYNC_MODE,
};
