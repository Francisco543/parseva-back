/**
 * @file Servicio de auditoría: registra eventos relevantes (cambios de
 * configuración, login, integraciones creadas/desconectadas, etc.) y permite
 * consultarlos por workspace.
 *
 * Convenciones:
 *  - `action` debe ser una clave estable, idealmente declarada en
 *    `constants/audit-actions.js`, con formato `dominio.subdominio.evento`.
 *  - `entityType`/`entityId` apuntan a la entidad afectada por la acción.
 *  - `metadata` es un objeto serializable (JSON). Nunca se guardan secretos.
 *
 * @module services/audit
 */

const prisma = require("../lib/prisma");

/**
 * @typedef {object} AuditEventInput
 * @property {string} action            Clave canónica del evento.
 * @property {string|null} [userId]
 * @property {string|null} [workspaceId]
 * @property {string|null} [entityType]
 * @property {string|null} [entityId]
 * @property {Record<string, unknown>|null} [metadata]
 * @property {string|null} [ip]
 * @property {string|null} [userAgent]
 */

/**
 * @typedef {object} AuditFromRequestPartial
 * @property {string} action
 * @property {string|null} [entityType]
 * @property {string|null} [entityId]
 * @property {Record<string, unknown>|null} [metadata]
 */

/**
 * Convierte cualquier valor en un objeto JSON apto para Prisma.
 * Si recibe primitivo lo envuelve en `{ value }`.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>|null}
 */
function safeJson(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "object") return /** @type {Record<string, unknown>} */ (value);
  return { value };
}

/**
 * Crea un evento de auditoría persistido.
 *
 * Si `action` viene vacío devuelve `null` sin lanzar para no fallar nunca el
 * flujo principal por una auditoría mal armada.
 *
 * @param {AuditEventInput} input
 * @returns {Promise<import('@prisma/client').AuditEvent | null>}
 */
async function createAuditEvent(input) {
  const action = String(input?.action || "").trim();
  if (!action) return null;

  return prisma.auditEvent.create({
    data: {
      action,
      userId: input.userId || null,
      workspaceId: input.workspaceId || null,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      metadata: safeJson(input.metadata),
      ip: input.ip || null,
      userAgent: input.userAgent || null,
    },
  });
}

/**
 * Atajo para registrar eventos desde un endpoint Express. Toma `userId`,
 * `workspaceId`, `ip` y `user-agent` directamente del `req` y completa el
 * resto a partir del payload parcial.
 *
 * @param {import('express').Request & {
 *   dbUser?: { id: string },
 *   workspace?: { id: string },
 * }} req
 * @param {AuditFromRequestPartial} partial
 * @returns {Promise<import('@prisma/client').AuditEvent | null>}
 */
async function auditFromRequest(req, partial) {
  return createAuditEvent({
    action: partial.action,
    userId: req.dbUser?.id || null,
    workspaceId: req.workspace?.id || null,
    entityType: partial.entityType ?? null,
    entityId: partial.entityId ?? null,
    metadata: partial.metadata ?? null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
  });
}

/**
 * Lista paginada de eventos del workspace, ordenados por `createdAt` desc.
 *
 * El primer argumento (`_requesterUserId`) se acepta por compatibilidad con
 * llamadores existentes; el filtrado se hace exclusivamente por workspace
 * porque la autorización se realizó en el middleware previo.
 *
 * @param {string} _requesterUserId
 * @param {string} workspaceId
 * @param {{ take?: number, skip?: number }} [options]
 * @returns {Promise<{ items: Array<import('@prisma/client').AuditEvent>, total: number }>}
 */
async function listAuditEvents(_requesterUserId, workspaceId, { take = 50, skip = 0 } = {}) {
  const where = { workspaceId };
  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        user: { select: { id: true, email: true, fullName: true } },
      },
    }),
    prisma.auditEvent.count({ where }),
  ]);
  return { items, total };
}

module.exports = {
  createAuditEvent,
  auditFromRequest,
  listAuditEvents,
};
