/**
 * @file Middleware de autenticación por Bearer Token (Azure AD).
 *
 * Verifica la firma del JWT contra el JWKS de Microsoft, valida issuer/tenant
 * y `audience`, y luego persiste/upsertea el usuario en la base de datos
 * (`req.dbUser`).
 *
 * Se usa para clientes que llaman directamente con un token de acceso (en
 * vez de usar la cookie de sesión). Por ejemplo: integraciones SDK o testing.
 *
 * @module middlewares/auth
 */

const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const env = require("../config/env");
const { upsertUserFromToken } = require("../services/user.service");

const AUTHORITY_HOST = "https://login.microsoftonline.com";

const client = jwksClient({
  // Para APIs SaaS multi-tenant, el endpoint `common` permite validar tokens de cualquier tenant.
  jwksUri: `${AUTHORITY_HOST}/common/discovery/v2.0/keys`,
  cache: true,
  rateLimit: true,
});

/**
 * Resuelve la clave pública correspondiente al `kid` del token.
 *
 * @param {import('jsonwebtoken').JwtHeader} header
 * @param {(err: Error|null, signingKey?: string) => void} callback
 */
function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }

    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Tras validar el token, asegura que el usuario exista en BD.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function attachDbUser(req, res, next) {
  if (!req.user) return next();

  try {
    const dbUser = await upsertUserFromToken(req.user);
    req.dbUser = dbUser;
    return next();
  } catch (err) {
    return res.status(500).json({
      message: "Could not sync user",
      detail: err.message,
    });
  }
}

/**
 * Middleware Express: exige `Authorization: Bearer <token>` válido.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authenticateBearerToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing bearer token" });
  }

  return jwt.verify(
    token,
    getSigningKey,
    {
      audience: env.msalAllowedAudiences,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) {
        return res.status(401).json({
          message: "Invalid token",
          detail: err.message,
        });
      }

      const tid = decoded?.tid;
      const issuer = decoded?.iss || "";
      const expectedIssuer = `${AUTHORITY_HOST}/${tid}/v2.0`;
      const isIssuerValid = Boolean(tid) && issuer === expectedIssuer;
      const isSingleTenantMode = env.msalTenantId !== "common";
      const isAllowedTenant =
        env.msalAllowedTenantIds.length === 0 || env.msalAllowedTenantIds.includes(tid);

      if (!isIssuerValid) {
        return res.status(401).json({ message: "Invalid token issuer" });
      }

      if (isSingleTenantMode && tid !== env.msalTenantId) {
        return res.status(401).json({ message: "Tenant not allowed for this API" });
      }

      if (!isSingleTenantMode && !isAllowedTenant) {
        return res.status(401).json({ message: "Tenant not allowed by whitelist" });
      }

      req.user = decoded;
      return attachDbUser(req, res, next);
    }
  );
}

module.exports = {
  authenticateBearerToken,
};
