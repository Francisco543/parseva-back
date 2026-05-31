/**
 * Middleware RBAC: exige uno de los permisos indicados (OR).
 * Requiere `requireWorkspaceContext` antes (para `req.workspaceMembership`).
 *
 * @module middlewares/rbac
 */

const HttpError = require("../utils/http-error");
const { hasPermission } = require("../constants/rbac");

/**
 * @param {...string} permissions Al menos uno debe cumplirse
 * @returns {import('express').RequestHandler}
 */
function requirePermission(...permissions) {
  if (!permissions.length) {
    throw new Error("requirePermission needs at least one permission");
  }
  return function rbacMiddleware(req, res, next) {
    const role = req.workspaceMembership?.role;
    if (!role) {
      return next(new HttpError(403, "Sin rol en el workspace"));
    }
    const ok = permissions.some((p) => hasPermission(role, p));
    if (!ok) {
      return next(
        new HttpError(403, `Permisos insuficientes (requiere: ${permissions.join(" o ")})`)
      );
    }
    return next();
  };
}

module.exports = {
  requirePermission,
};
