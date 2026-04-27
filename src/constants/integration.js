/**
 * @file Constantes para integraciones externas (`IntegrationConnection`).
 *
 * @module constants/integration
 */

/**
 * Tipos válidos de integración.
 *
 * @typedef {(typeof INTEGRATION_KIND)[keyof typeof INTEGRATION_KIND]} IntegrationKind
 */
const INTEGRATION_KIND = Object.freeze({
  EMAIL: "email",
  SHAREPOINT: "sharepoint",
  BUSINESS_CENTRAL: "business_central",
});

/** Lista de todos los tipos válidos (para validaciones con Zod, etc.). */
const INTEGRATION_KIND_LIST = Object.freeze(Object.values(INTEGRATION_KIND));

/**
 * Estados estables de la conexión (`IntegrationConnection.status`).
 *
 * @typedef {(typeof INTEGRATION_STATUS)[keyof typeof INTEGRATION_STATUS]} IntegrationStatus
 */
const INTEGRATION_STATUS = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTED: "CONNECTED",
  ERROR: "ERROR",
});

/**
 * Roles de membership en un workspace.
 *
 * @typedef {(typeof WORKSPACE_ROLE)[keyof typeof WORKSPACE_ROLE]} WorkspaceRole
 */
const WORKSPACE_ROLE = Object.freeze({
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
});

module.exports = {
  INTEGRATION_KIND,
  INTEGRATION_KIND_LIST,
  INTEGRATION_STATUS,
  WORKSPACE_ROLE,
};
