/**
 * @file Middleware de contexto por request:
 *  - Genera un `requestId` estable (acepta `x-request-id` / `x-correlation-id`).
 *  - Inyecta un logger pino enriquecido en `req.log`.
 *  - Devuelve `x-request-id` en la respuesta para correlación cliente/servidor.
 *
 * @module middlewares/request-context
 */

const crypto = require("crypto");
const pinoHttp = require("pino-http");
const { logger } = require("../lib/logger");

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRequestId(req) {
  const header = req.headers["x-request-id"] || req.headers["x-correlation-id"] || null;
  const candidate = Array.isArray(header) ? header[0] : header;
  return String(candidate || "").trim() || crypto.randomUUID();
}

/**
 * Construye la cadena de middlewares de contexto.
 *
 * @returns {import('express').RequestHandler[]}
 */
function requestContext() {
  return [
    (req, res, next) => {
      req.id = getRequestId(req);
      res.setHeader("x-request-id", req.id);
      next();
    },
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customProps: (req) => ({
        requestId: req.id,
        userId: req.dbUser?.id || null,
        workspaceId: req.workspace?.id || null,
        route: req.originalUrl || null,
      }),
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            query: req.query,
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  ];
}

module.exports = {
  requestContext,
};
