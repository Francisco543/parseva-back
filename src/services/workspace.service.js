const prisma = require("../lib/prisma");

async function ensureWorkspaceForUser({ userId, tid, fallbackName }) {
  const workspace = await prisma.workspace.upsert({
    where: { aadTenantId: tid },
    update: {},
    create: {
      aadTenantId: tid,
      name: fallbackName || `Workspace ${tid.slice(0, 8)}`,
    },
  });

  const membership = await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId: workspace.id,
      },
    },
    update: {},
    create: {
      userId,
      workspaceId: workspace.id,
      role: "ADMIN",
    },
  });

  return { workspace, membership };
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
