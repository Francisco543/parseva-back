/**
 * @file Excepción tipada para errores HTTP del backend.
 *
 * Cuando un servicio o controlador lanza un `HttpError`, el manejador global
 * en `app.js` lee `statusCode` y `details` para construir la respuesta JSON
 * adecuada sin exponer el stack trace al cliente.
 *
 * @module utils/http-error
 *
 * @example
 *   throw new HttpError(404, "Workspace not found");
 *   throw new HttpError(400, "Payload inválido", { issues });
 */

class HttpError extends Error {
  /**
   * @param {number} statusCode  Código HTTP (4xx/5xx).
   * @param {string} message     Mensaje legible (cliente y log).
   * @param {unknown} [details]  Información adicional opcional (validación, body de Graph, etc.).
   */
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = HttpError;
