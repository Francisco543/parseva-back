/**
 * @file Helpers para firmar y verificar las cookies de sesión y de flujo OAuth.
 *
 * Se usan dos JWT distintos firmados con la misma `SESSION_SECRET`:
 *  - **Session token** (`signSession`/`readSession`): válido por 8 horas, lo
 *    porta el navegador como cookie `httpOnly` para autenticar las llamadas.
 *  - **Auth flow token** (`signAuthFlow`/`readAuthFlow`): válido por 10 minutos
 *    y se utiliza para mantener el estado del flujo de login (PKCE state).
 *
 * @module lib/session
 */

const jwt = require("jsonwebtoken");
const env = require("../config/env");

const SESSION_EXPIRATION = "8h";
const FLOW_EXPIRATION = "10m";

/**
 * @typedef {object} CookieOptions
 * @property {true} httpOnly
 * @property {"lax"|"strict"|"none"} sameSite
 * @property {boolean} secure
 * @property {string} path
 */

/**
 * Devuelve opciones de cookie seguras coherentes en toda la app.
 *
 * @returns {CookieOptions}
 */
function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.nodeEnv === "production",
    path: "/",
  };
}

/**
 * Firma un payload como token de sesión (válido 8h).
 *
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function signSession(payload) {
  return jwt.sign(payload, env.sessionSecret, {
    algorithm: "HS256",
    expiresIn: SESSION_EXPIRATION,
  });
}

/**
 * Verifica un token de sesión y devuelve su payload decodificado.
 *
 * @param {string} token
 * @returns {Record<string, unknown>}
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError}
 */
function readSession(token) {
  return jwt.verify(token, env.sessionSecret, {
    algorithms: ["HS256"],
  });
}

/**
 * Firma un payload corto-vida para mantener el estado del flujo OAuth.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function signAuthFlow(payload) {
  return jwt.sign(payload, env.sessionSecret, {
    algorithm: "HS256",
    expiresIn: FLOW_EXPIRATION,
  });
}

/**
 * Verifica un token de auth flow.
 *
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
function readAuthFlow(token) {
  return jwt.verify(token, env.sessionSecret, {
    algorithms: ["HS256"],
  });
}

module.exports = {
  getCookieOptions,
  signSession,
  readSession,
  signAuthFlow,
  readAuthFlow,
};
