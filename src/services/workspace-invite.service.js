/**
 * Invitaciones al workspace por correo (mismo tenant Azure AD).
 * La aceptación ocurre en login: ver `resolveInviteForNewMembership` y
 * `closePendingInvitesForExistingMember`.
 *
 * @module services/workspace-invite
 */

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

const INVITE_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
};

const ASSIGNABLE_ROLES = new Set(["ADMIN", "EDITOR", "VIEWER"]);

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @param {string | null | undefined} raw
 * @returns {string}
 */
function normalizeInviteEmail(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} workspaceId
 */
async function expireStaleInvites(workspaceId) {
  await prisma.workspaceInvite.updateMany({
    where: {
      workspaceId,
      status: INVITE_STATUS.PENDING,
      expiresAt: { lt: new Date() },
    },
    data: { status: INVITE_STATUS.EXPIRED },
  });
}

/**
 * @param {string} workspaceId
 */
async function listInvites(workspaceId) {
  await expireStaleInvites(workspaceId);

  const pending = await prisma.workspaceInvite.findMany({
    where: { workspaceId, status: INVITE_STATUS.PENDING },
    include: {
      invitedBy: { select: { id: true, email: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const acceptedRecent = await prisma.workspaceInvite.findMany({
    where: { workspaceId, status: INVITE_STATUS.ACCEPTED },
    include: {
      invitedBy: { select: { id: true, email: true, fullName: true } },
    },
    orderBy: { acceptedAt: "desc" },
    take: 15,
  });

  return { pending, acceptedRecent };
}

/**
 * @param {string} workspaceId
 * @param {{ email: string, role: string, invitedByUserId: string }} input
 */
async function createInvite(workspaceId, { email, role, invitedByUserId }) {
  const emailNorm = normalizeInviteEmail(email);
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    throw new HttpError(400, "Correo inválido");
  }
  const roleUpper = String(role || "")
    .trim()
    .toUpperCase();
  if (!ASSIGNABLE_ROLES.has(roleUpper)) {
    throw new HttpError(400, "Rol inválido (ADMIN, EDITOR o VIEWER)");
  }

  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: emailNorm, mode: "insensitive" } },
  });
  if (existingUser) {
    const member = await prisma.workspaceMembership.findFirst({
      where: { workspaceId, userId: existingUser.id },
    });
    if (member) {
      throw new HttpError(409, "Ese usuario ya es miembro del workspace");
    }
  }

  await expireStaleInvites(workspaceId);

  const dup = await prisma.workspaceInvite.findFirst({
    where: {
      workspaceId,
      email: emailNorm,
      status: INVITE_STATUS.PENDING,
    },
  });
  if (dup) {
    throw new HttpError(409, "Ya hay una invitación pendiente para ese correo");
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const row = await prisma.workspaceInvite.create({
    data: {
      workspaceId,
      email: emailNorm,
      role: roleUpper,
      status: INVITE_STATUS.PENDING,
      invitedByUserId,
      expiresAt,
    },
    include: {
      invitedBy: { select: { id: true, email: true, fullName: true } },
    },
  });

  return row;
}

/**
 * @param {string} workspaceId
 * @param {string} inviteId
 */
async function revokeInvite(workspaceId, inviteId) {
  const row = await prisma.workspaceInvite.findFirst({
    where: { id: inviteId, workspaceId },
  });
  if (!row) {
    throw new HttpError(404, "Invitación no encontrada");
  }
  if (row.status !== INVITE_STATUS.PENDING) {
    throw new HttpError(400, "Solo se pueden revocar invitaciones pendientes");
  }
  return prisma.workspaceInvite.update({
    where: { id: inviteId },
    data: { status: INVITE_STATUS.REVOKED },
  });
}

/**
 * Invitación vigente para un email (login nuevo).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} [tx]
 * @param {string} workspaceId
 * @param {string} emailNorm
 */
async function findActivePendingInvite(tx, workspaceId, emailNorm) {
  const client = tx || prisma;
  if (!emailNorm) return null;
  const now = new Date();
  return client.workspaceInvite.findFirst({
    where: {
      workspaceId,
      email: emailNorm,
      status: INVITE_STATUS.PENDING,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Rol al crear membresía: invitación pendiente o ADMIN por defecto.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} workspaceId
 * @param {string} emailNorm
 * @returns {Promise<{ role: string, inviteId: string | null }>}
 */
async function resolveInviteForNewMembership(tx, workspaceId, emailNorm) {
  const inv = await findActivePendingInvite(tx, workspaceId, emailNorm);
  if (!inv) {
    return { role: "ADMIN", inviteId: null };
  }
  const r = String(inv.role || "").toUpperCase();
  return { role: ASSIGNABLE_ROLES.has(r) ? r : "VIEWER", inviteId: inv.id };
}

/**
 * Marca invitaciones pendientes del correo como aceptadas (usuario ya miembro).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} emailNorm
 */
async function closePendingInvitesForExistingMember(tx, workspaceId, userId, emailNorm) {
  if (!emailNorm) return;
  const client = tx || prisma;
  await client.workspaceInvite.updateMany({
    where: {
      workspaceId,
      email: emailNorm,
      status: INVITE_STATUS.PENDING,
    },
    data: {
      status: INVITE_STATUS.ACCEPTED,
      acceptedAt: new Date(),
      acceptedByUserId: userId,
    },
  });
}

/**
 * Tras crear membresía con rol desde invitación.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} inviteId
 * @param {string} acceptedByUserId
 */
async function markInviteAccepted(tx, inviteId, acceptedByUserId) {
  const client = tx || prisma;
  await client.workspaceInvite.update({
    where: { id: inviteId },
    data: {
      status: INVITE_STATUS.ACCEPTED,
      acceptedAt: new Date(),
      acceptedByUserId,
    },
  });
}

module.exports = {
  INVITE_STATUS,
  normalizeInviteEmail,
  listInvites,
  createInvite,
  revokeInvite,
  resolveInviteForNewMembership,
  closePendingInvitesForExistingMember,
  markInviteAccepted,
  findActivePendingInvite,
  expireStaleInvites,
};
