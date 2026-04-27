const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

function toSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 50);
}

async function createTenantForUser({ userId, name, slug }) {
  const normalizedSlug = (slug || toSlug(name || "")).trim();
  if (!name || !normalizedSlug) {
    throw new HttpError(400, "name or slug invalid");
  }

  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: name.trim(),
        slug: normalizedSlug,
        ownerUserId: userId,
      },
    });

    await tx.membership.create({
      data: {
        userId,
        tenantId: tenant.id,
        role: "OWNER",
      },
    });

    return tenant;
  });
}

async function listTenantsForUser(userId) {
  return prisma.membership.findMany({
    where: { userId },
    include: { tenant: true },
    orderBy: { createdAt: "desc" },
  });
}

module.exports = {
  createTenantForUser,
  listTenantsForUser,
};
