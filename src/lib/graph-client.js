/**
 * @file Cliente de Microsoft Graph (modo *application*: client credentials).
 *
 * Se mantiene un `ConfidentialClientApplication` cacheado por tenant para
 * evitar reconstruir MSAL en cada request, y se usa `fetch` global de Node
 * para emitir las llamadas HTTP. Todas las funciones lanzan `HttpError(502)`
 * con el detalle del error de Graph cuando la respuesta no es 2xx.
 *
 * Convenciones:
 *  - `path` puede ser absoluto (URL completa) o relativo a `/v1.0`.
 *  - `options.tenantId` permite hacer override del tenant por llamada.
 *
 * @module lib/graph-client
 */

const { ConfidentialClientApplication } = require("@azure/msal-node");
const env = require("../config/env");
const HttpError = require("../utils/http-error");

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];

/** @type {Map<string, ConfidentialClientApplication>} */
const clientsByTenant = new Map();

/**
 * @param {string} [tenantId]
 * @returns {ConfidentialClientApplication}
 */
function getGraphClient(tenantId) {
  const key = tenantId || env.graphTenantId;
  if (!clientsByTenant.has(key)) {
    clientsByTenant.set(
      key,
      new ConfidentialClientApplication({
        auth: {
          clientId: env.graphClientId,
          authority: `https://login.microsoftonline.com/${key}`,
          clientSecret: env.graphClientSecret,
        },
      })
    );
  }
  return clientsByTenant.get(key);
}

/**
 * Obtiene un access token *application* para Graph en el tenant indicado
 * (o el configurado por defecto). Lanza si las credenciales no están seteadas.
 *
 * @param {string} [tenantId]
 * @returns {Promise<string>}
 */
async function getGraphAccessToken(tenantId) {
  if (!env.graphClientId || !env.graphClientSecret || !env.graphTenantId) {
    throw new HttpError(500, "Graph credentials are not configured");
  }

  const result = await getGraphClient(tenantId).acquireTokenByClientCredential({
    scopes: GRAPH_SCOPES,
  });

  if (!result?.accessToken) {
    throw new HttpError(500, "Could not acquire Graph access token");
  }

  return result.accessToken;
}

/**
 * @param {string} path
 * @returns {string}
 */
function buildGraphUrl(path) {
  if (path.startsWith("http")) return path;
  return `https://graph.microsoft.com/v1.0${path}`;
}

/**
 * Construye los headers para la llamada agregando `Authorization` y, si hace
 * falta, `Content-Type: application/json` cuando el body es string.
 *
 * @param {RequestInit} init
 * @param {string} accessToken
 * @returns {Headers}
 */
function buildHeaders(init, accessToken) {
  const raw = init.headers || {};
  const merged = new Headers(raw);
  merged.set("Authorization", `Bearer ${accessToken}`);

  const body = init.body;
  const hasExplicitCt = merged.has("Content-Type") || merged.has("content-type");
  if (body != null && typeof body === "string" && !hasExplicitCt) {
    merged.set("Content-Type", "application/json");
  }

  return merged;
}

/**
 * Wrapper bajo nivel sobre `fetch` para Graph. Lanza `HttpError(502)` con el
 * cuerpo de la respuesta si no es 2xx.
 *
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {{ tenantId?: string }} [options]
 * @returns {Promise<Response>}
 */
async function graphFetch(path, init = {}, options = {}) {
  const accessToken = await getGraphAccessToken(options.tenantId);
  const headers = buildHeaders(init, accessToken);

  const response = await fetch(buildGraphUrl(path), {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(502, "Graph request failed", text);
  }

  return response;
}

/**
 * Llamada Graph con respuesta JSON (o `null` para 204 / body vacío).
 *
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {{ tenantId?: string }} [options]
 * @returns {Promise<unknown>}
 */
async function graphRequest(path, init = {}, options = {}) {
  const response = await graphFetch(path, init, options);
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Descarga un recurso Graph como buffer (útil para attachments / archivos).
 *
 * @param {string} path
 * @param {{ tenantId?: string }} [options]
 * @returns {Promise<Buffer>}
 */
async function graphGetBuffer(path, options = {}) {
  const response = await graphFetch(path, { method: "GET" }, options);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Sube contenido a un recurso Graph con método PUT (usado para subir archivos
 * a SharePoint/OneDrive cuando son menores a ~4MB).
 *
 * @param {string} path
 * @param {BodyInit} body
 * @param {string} [contentType]
 * @param {{ tenantId?: string }} [options]
 * @returns {Promise<unknown>}
 */
async function graphPutContent(path, body, contentType, options = {}) {
  const response = await graphFetch(
    path,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType || "application/octet-stream",
      },
      body,
    },
    options
  );
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  getGraphAccessToken,
  graphRequest,
  graphFetch,
  graphGetBuffer,
  graphPutContent,
};
