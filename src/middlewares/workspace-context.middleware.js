/**
 * @file Middleware que verifica que el usuario tenga membresía activa en el
 * workspace presente en su sesión y carga la membresía en `req.workspaceMembership`.
 *
 * Debe usarse SIEMPRE después de un middleware de autenticación que llene
 * `req.workspace` y `req.dbUser` (por ejemplo `authenticateSession`).
 *
 * @module middlewares/workspace-context
 */

const prisma = require("../lib/prisma");

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireWorkspaceContext(req, res, next) {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) {
    return res.status(401).json({ message: "Workspace not found in session" });
  }

  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      workspaceId,
      userId: req.dbUser.id,
    },
  });
  if (!membership) {
    return res.status(403).json({ message: "No workspace membership" });
  }

  req.workspaceMembership = membership;
  return next();
}

/**
 * Helper de composición: aplica `authenticateSession` y luego
 * `requireWorkspaceContext`. Útil para no repetir el mismo par en cada ruta.
 *
 * @returns {import('express').RequestHandler[]}
 *
 * @example
 *   const { combineAuth } = require("../middlewares/workspace-context.middleware");
 *   router.get("/foo", ...combineAuth(), asyncHandler(handler));
 */
function combineAuth() {
  const {
    authenticateSession,
  } = require("./session-auth.middleware"); // require diferido para evitar ciclos
  return [authenticateSession, requireWorkspaceContext];
}

module.exports = {
  requireWorkspaceContext,
  combineAuth,
};
