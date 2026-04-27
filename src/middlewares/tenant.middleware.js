/**
 * @file Middleware que resuelve el tenant a partir del header `x-tenant-slug`
 * y verifica que el usuario tenga membresía en él.
 *
 * Notas:
 *  - Este middleware aplica al modelo "Tenant/Membership" (anterior al modelo
 *    Workspace/WorkspaceMembership). Se mantiene para compatibilidad con
 *    endpoints que aún lo usan.
 *  - Requiere que un middleware previo haya establecido `req.dbUser`.
 *
 * @module middlewares/tenant
 */

const prisma = require("../lib/prisma");

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireTenantContext(req, res, next) {
  const tenantSlug = req.headers["x-tenant-slug"];

  if (!tenantSlug || typeof tenantSlug !== "string") {
    return res.status(400).json({ message: "Missing x-tenant-slug header" });
  }

  const userId = req.dbUser?.id;
  if (!userId) {
    return res.status(401).json({ message: "User not authenticated" });
  }

  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      tenant: { slug: tenantSlug },
    },
    include: {
      tenant: true,
    },
  });

  if (!membership) {
    return res.status(403).json({ message: "No membership for tenant" });
  }

  req.tenant = membership.tenant;
  req.membership = membership;
  return next();
}

module.exports = {
  requireTenantContext,
};
