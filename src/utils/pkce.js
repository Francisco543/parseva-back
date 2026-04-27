/**
 * @file Helpers para generar pares PKCE (`verifier`/`challenge`) para el flujo
 * OAuth Authorization Code with PKCE de Microsoft Identity.
 *
 * @module utils/pkce
 */

const crypto = require("node:crypto");

/**
 * Codifica un buffer en `base64url` (sin padding).
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function toBase64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Genera un par PKCE compatible con el método S256.
 *
 * @returns {{ verifier: string, challenge: string }}
 */
function createPkceCodes() {
  const verifier = toBase64Url(crypto.randomBytes(32));
  const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
}

module.exports = {
  createPkceCodes,
};
