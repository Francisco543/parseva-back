/**
 * @file Listado y actualización de roles de `WorkspaceMembership`.
 * @module services/workspace-members
 */

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { normalizeRole } = require("../constants/rbac");

/** Roles persistibles (canónicos). */
const ASSIGNABLE_ROLES = new Set(["ADMIN", "EDITOR", "VIEWER"]);

/** @param {any} row Fila Prisma con `user` incluido. */
function formatMemberRow(row) {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    fullName: row.user.fullName,
    azureOid: row.user.azureOid,
    role: row.role,
    roleNormalized: normalizeRole(row.role),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * @param {string} workspaceId
 */
async function listMembers(workspaceId) {
  const rows = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          azureOid: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(formatMemberRow);
}

/**
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.membershipId
 * @param {string} input.nextRole ADMIN | EDITOR | VIEWER
 */
async function updateMemberRole({ workspaceId, membershipId, nextRole }) {
  const roleUpper = String(nextRole || "")
    .trim()
    .toUpperCase();
  if (!ASSIGNABLE_ROLES.has(roleUpper)) {
    throw new HttpError(400, "Rol inválido. Usá ADMIN, EDITOR o VIEWER.");
  }

  const membership = await prisma.workspaceMembership.findFirst({
    where: { id: membershipId, workspaceId },
    include: {
      user: { select: { id: true, email: true, fullName: true, azureOid: true } },
    },
  });
  if (!membership) {
    throw new HttpError(404, "Membresía no encontrada");
  }

  const previousRaw = membership.role;
  const previousNorm = normalizeRole(previousRaw);
  const nextNorm = normalizeRole(roleUpper);

  if (previousNorm === nextNorm && String(previousRaw).toUpperCase() === roleUpper) {
    return {
      membership: formatMemberRow(membership),
      changed: false,
    };
  }

  const all = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    select: { id: true, role: true, userId: true },
  });

  const adminCount = all.filter((row) => normalizeRole(row.role) === "ADMIN").length;
  const wasAdmin = previousNorm === "ADMIN";
  const becomesNonAdmin = nextNorm !== "ADMIN";

  if (wasAdmin && becomesNonAdmin && adminCount <= 1) {
    throw new HttpError(
      400,
      "No podés quitar el único administrador del workspace. Designá otro admin antes."
    );
  }

  const updated = await prisma.workspaceMembership.update({
    where: { id: membership.id },
    data: { role: roleUpper },
    include: {
      user: {
        select: { id: true, email: true, fullName: true, azureOid: true },
      },
    },
  });

  return {
    membership: formatMemberRow(updated),
    changed: true,
    previousRole: previousRaw,
  };
}

module.exports = {
  listMembers,
  updateMemberRole,
};
