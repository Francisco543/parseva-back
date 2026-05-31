/**
 * Roles y permisos por workspace (`WorkspaceMembership.role`).
 *
 * Roles canónicos tras normalizar: VIEWER | EDITOR | ADMIN
 * Valores legacy en DB (p. ej. "ADMIN") se mapean aquí.
 *
 * @module constants/rbac
 */

/** @type {const} */
const PERMISSIONS = {
  /** Listar/ver documentos, PDF, layout, notas (GET) */
  DOCUMENTS_READ: "documents:read",
  /** Subir, reprocesar, aprobar/rechazar, editar extracción, notas (POST/PATCH) */
  DOCUMENTS_MANAGE: "documents:manage",
  /** Ver tipos documentales, integraciones, automatización, BC mappings (solo GET) */
  CONFIG_READ: "config:read",
  /** Crear/editar tipos, integraciones, automatización, webhooks, API keys, studio… */
  CONFIG_WRITE: "config:write",
  /** Ver auditoría */
  AUDIT_READ: "audit:read",
};

/** Marcador interno: rol ADMIN tiene todos los permisos */
const ALL = "*";

/**
 * @param {string | null | undefined} raw
 * @returns {"VIEWER"|"EDITOR"|"ADMIN"}
 */
function normalizeRole(raw) {
  const u = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (u === "ADMIN" || u === "OWNER") return "ADMIN";
  if (u === "EDITOR" || u === "OPERATOR" || u === "MEMBER" || u === "CONTRIBUTOR") return "EDITOR";
  if (u === "VIEWER" || u === "READER") return "VIEWER";
  return "VIEWER";
}

/**
 * Lista de permisos efectivos para UI y checks (sin wildcard expandido).
 *
 * @param {string | null | undefined} membershipRole
 * @returns {string[]}
 */
function listPermissionsForRole(membershipRole) {
  const r = normalizeRole(membershipRole);
  if (r === "ADMIN") {
    return [
      ALL,
      PERMISSIONS.DOCUMENTS_READ,
      PERMISSIONS.DOCUMENTS_MANAGE,
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.CONFIG_WRITE,
      PERMISSIONS.AUDIT_READ,
    ];
  }
  if (r === "EDITOR") {
    return [
      PERMISSIONS.DOCUMENTS_READ,
      PERMISSIONS.DOCUMENTS_MANAGE,
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.AUDIT_READ,
    ];
  }
  return [PERMISSIONS.DOCUMENTS_READ, PERMISSIONS.CONFIG_READ];
}

/**
 * @param {string | null | undefined} membershipRole
 * @param {string} permission
 */
function hasPermission(membershipRole, permission) {
  const list = listPermissionsForRole(membershipRole);
  if (list.includes(ALL)) return true;
  return list.includes(permission);
}

module.exports = {
  PERMISSIONS,
  ALL,
  normalizeRole,
  listPermissionsForRole,
  hasPermission,
};
