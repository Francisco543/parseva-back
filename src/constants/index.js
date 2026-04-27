/**
 * @file Punto único de exportación de constantes del backend.
 *
 * Centralizar strings de status, tipos y acciones evita typos y facilita refactors.
 * Usar `Object.freeze` impide mutaciones accidentales en runtime.
 *
 * @module constants
 */

const documentStatus = require("./document-status");
const jobStatus = require("./job-status");
const auditActions = require("./audit-actions");
const integration = require("./integration");
const matching = require("./matching");
const bcSync = require("./bc-sync");

module.exports = {
  ...documentStatus,
  ...jobStatus,
  ...auditActions,
  ...integration,
  ...matching,
  ...bcSync,
};
