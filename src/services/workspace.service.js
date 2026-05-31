const prisma = require("../lib/prisma");
const {
  normalizeInviteEmail,
  resolveInviteForNewMembership,
  closePendingInvitesForExistingMember,
  markInviteAccepted,
} = require("./workspace-invite.service");
const { ensureWorkspaceDefaultDocumentTypes } = require("./document-type.service");

/**
 * @typedef {object} EnsureWorkspaceResult
 * @property {import("@prisma/client").Workspace} workspace
 * @property {import("@prisma/client").WorkspaceMembership} membership
 * @property {string | null} acceptedInviteId
 */

/**
 * Asegura workspace por tenant Azure y membresía del usuario.
 * Si hay invitación PENDING para el correo del login, la membresía nueva usa ese rol.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tid Azure AD tenant id
 * @param {string} [input.fallbackName]
 * @param {string} [input.loginEmail] Email del id_token (invitaciones mismo tenant)
 */
async function ensureWorkspaceForUser({ userId, tid, fallbackName, loginEmail }) {
  const workspace = await prisma.workspace.upsert({
    where: { aadTenantId: tid },
    update: {},
    create: {
      aadTenantId: tid,
      name: fallbackName || `Workspace ${tid.slice(0, 8)}`,
    },
  });

  const emailNorm = normalizeInviteEmail(loginEmail);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId: workspace.id,
        },
      },
    });

    if (existing) {
      await closePendingInvitesForExistingMember(tx, workspace.id, userId, emailNorm);
      return { workspace, membership: existing, acceptedInviteId: null };
    }

    const { role, inviteId } = await resolveInviteForNewMembership(tx, workspace.id, emailNorm);

    const membership = await tx.workspaceMembership.create({
      data: {
        userId,
        workspaceId: workspace.id,
        role,
      },
    });

    if (inviteId) {
      await markInviteAccepted(tx, inviteId, userId);
    }

    return { workspace, membership, acceptedInviteId: inviteId };
  });

  // Idempotente: garantiza catalogo base BC aunque el workspace ya existiera.
  await ensureWorkspaceDefaultDocumentTypes(workspace.id);
  return result;
}

async function listWorkspacesForUser(userId) {
  return prisma.workspaceMembership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
}

async function getMembership(userId, workspaceId) {
  return prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
    include: { workspace: true },
  });
}

module.exports = {
  ensureWorkspaceForUser,
  listWorkspacesForUser,
  getMembership,
};
