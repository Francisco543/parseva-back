/**
 * @file Middleware de autenticación basada en cookie de sesión firmada.
 *
 * Lee la cookie configurada en `env.sessionCookieName`, valida la firma con
 * `lib/session.js` y popula:
 *  - `req.session`: payload completo decodificado.
 *  - `req.user`: claims tipo Microsoft (oid/tid/preferred_username).
 *  - `req.dbUser`: usuario persistido (id de Postgres).
 *  - `req.workspace`: workspace activo seleccionado en el login.
 *
 * Si no hay cookie o la firma falla devuelve 401 sin invocar el siguiente
 * middleware.
 *
 * @module middlewares/session-auth
 */

const env = require("../config/env");
const { readSession } = require("../lib/session");

/**
 * @typedef {object} SessionPayload
 * @property {string} userId
 * @property {string} oid
 * @property {string} tid
 * @property {string} email
 * @property {string} name
 * @property {string} workspaceId
 * @property {string} workspaceName
 * @property {string} workspaceRole
 */

/**
 * Middleware Express: exige una cookie de sesión válida.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authenticateSession(req, res, next) {
  const token = req.cookies?.[env.sessionCookieName];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    /** @type {SessionPayload} */
    const session = readSession(token);
    req.session = session;
    req.user = {
      oid: session.oid,
      tid: session.tid,
      name: session.name,
      preferred_username: session.email,
    };
    req.dbUser = {
      id: session.userId,
      azureOid: session.oid,
      email: session.email,
      fullName: session.name,
    };
    req.workspace = {
      id: session.workspaceId,
      name: session.workspaceName,
      role: session.workspaceRole,
    };
    return next();
  } catch (_error) {
    return res.status(401).json({ message: "Invalid session" });
  }
}

module.exports = {
  authenticateSession,
};
