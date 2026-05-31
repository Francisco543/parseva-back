const prisma = require("../lib/prisma");
const { logger } = require("../lib/logger");
const env = require("../config/env");
const HttpError = require("../utils/http-error");
const { extractBcApiErrorMessage } = require("../utils/bc-erp-api-error-message");

/** Scope estándar para BC SaaS (client credentials). */
const BC_RESOURCE_SCOPE = "https://api.businesscentral.dynamics.com/.default";

/** Renovar el token esta cantidad de ms antes del vencimiento de Entra. */
const TOKEN_EXPIRY_BUFFER_MS = 120_000;

/** @type {Map<string, { accessToken: string; expiresAtMs: number }>} */
const tokenCache = new Map();

/** @type {Map<string, Promise<string>>} */
const tokenInflight = new Map();

/**
 * Invalida caché OAuth al cambiar credenciales en la integración (todas las variantes de tenant).
 *
 * @param {string} integrationId
 */
function invalidateBcTokenCache(integrationId) {
  for (const key of tokenCache.keys()) {
    if (key === integrationId || key.startsWith(`${integrationId}::`)) {
      tokenCache.delete(key);
    }
  }
  for (const key of tokenInflight.keys()) {
    if (key === integrationId || key.startsWith(`${integrationId}::`)) {
      tokenInflight.delete(key);
    }
  }
}

/**
 * Normaliza GUID de compañía para el segmento OData `companies({id})`.
 *
 * @param {unknown} id
 * @returns {string}
 */
function normalizeCompanyId(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  return s.replace(/^\{/, "").replace(/\}$/, "");
}

/**
 * Cliente web (barra de direcciones): `https://businesscentral.dynamics.com/{tenant}/{environment}`
 * Las llamadas OData/API deben usar `api.businesscentral.dynamics.com` y el segmento `/v2.0/`.
 *
 * @param {string} raw
 * @returns {{ tenant: string; environment: string } | null}
 */
function parseBcWebClientUrl(raw) {
  const s = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!s) return null;
  const m = s.match(
    /^https?:\/\/businesscentral\.dynamics\.com\/([0-9a-fA-F-]{36})\/([^/?#]+)\/?$/i,
  );
  if (!m) return null;
  return {
    tenant: m[1].replace(/^\{|\}$/g, ""),
    environment: decodeURIComponent(m[2]),
  };
}

/**
 * El dominio del navegador BC no es el host de la API.
 *
 * @param {string} [hostRaw]
 * @returns {string}
 */
function normalizeBcApiHost(hostRaw) {
  let h =
    typeof hostRaw === "string" && hostRaw.trim()
      ? hostRaw.trim().replace(/\/+$/, "")
      : "";
  if (!h) return "https://api.businesscentral.dynamics.com";
  if (/^https?:\/\/businesscentral\.dynamics\.com(\/|$)/i.test(h)) {
    return h.replace(
      /^https?:\/\/businesscentral\.dynamics\.com/i,
      "https://api.businesscentral.dynamics.com",
    );
  }
  return h;
}

/**
 * Rellena tenant / environment desde la URL del navegador BC si faltan en JSON.
 *
 * @param {Record<string, unknown>|undefined|null} cfg
 * @returns {Record<string, unknown>}
 */
function enrichBcConfigFromWebUrl(cfg) {
  const c =
    cfg && typeof cfg === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...cfg })
      : {};
  const pasted = c.baseUrl ?? c.apiBaseUrl;
  if (typeof pasted === "string" && pasted.trim()) {
    const w = parseBcWebClientUrl(pasted.trim());
    if (w) {
      if (!(c.tenantId ?? c.tenant)) c.tenantId = w.tenant;
      if (!(c.environment ?? c.environmentName)) c.environment = w.environment;
    }
  }
  return c;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripJsonBom(text) {
  return typeof text === "string" ? text.replace(/^\uFEFF/, "").trim() : "";
}

/**
 * Filas de compañía desde JSON API v2.0 u OData (variantes de envoltorio).
 *
 * @param {unknown} json
 * @returns {unknown[]}
 */
function extractCompanyRowsFromBcJson(json) {
  if (!json || typeof json !== "object") return [];
  const j = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(j.value)) return j.value;
  if (Array.isArray(j.Value)) return j.Value;
  if (Array.isArray(j.companies)) return j.companies;
  if (Array.isArray(j.results)) return j.results;
  const hasId = "id" in j || "Id" in j;
  const hasLabel =
    "name" in j ||
    "Name" in j ||
    "displayName" in j ||
    "Display_Name" in j;
  if (hasId && hasLabel) return [json];
  return [];
}

/**
 * GUID desde `@odata.id` (p. ej. …/companies(guid) o …(guid)).
 *
 * @param {string} odataId
 * @returns {string}
 */
function guidFromODataResourceUrl(odataId) {
  if (typeof odataId !== "string") return "";
  let m = odataId.match(/companies\(([0-9a-fA-F-]{36})\)/i);
  if (m) return normalizeCompanyId(m[1]);
  m = odataId.match(/\(([0-9a-fA-F-]{36})\)/);
  return m ? normalizeCompanyId(m[1]) : "";
}

/**
 * @param {unknown} row
 * @returns {{ id: string; name: string; displayName: string }}
 */
function mapBcCompanyRow(row) {
  const r =
    row && typeof row === "object"
      ? /** @type {Record<string, unknown>} */ (row)
      : {};
  let idRaw =
    r.id ??
    r.Id ??
    r.SystemId ??
    r.systemId ??
    "";
  if (!String(idRaw).trim()) {
    const od =
      typeof r["@odata.id"] === "string"
        ? r["@odata.id"]
        : typeof r["odata.id"] === "string"
          ? r["odata.id"]
          : "";
    idRaw = guidFromODataResourceUrl(od);
  }
  const id = normalizeCompanyId(idRaw);
  const name = String(r.name ?? r.Name ?? "").trim();
  const displayName = String(
    r.displayName ?? r.Display_Name ?? r.Name ?? r.name ?? "",
  ).trim();
  return { id, name, displayName };
}

/**
 * Construye la URL base OData hasta `.../companies({id})` (sin barra final).
 *
 * @param {Record<string, unknown>} cfg
 * @returns {string}
 */
function resolveBcApiBaseUrl(cfg) {
  const c = enrichBcConfigFromWebUrl(cfg);
  const explicit = c.baseUrl ?? c.apiBaseUrl;
  const publisher = typeof c.apiPublisher === "string" ? c.apiPublisher : "parseva";
  const group = typeof c.apiGroup === "string" ? c.apiGroup : "parseva";
  const version = typeof c.apiVersion === "string" ? c.apiVersion : "v1.0";
  const apiSegment = `/api/${publisher}/${group}/${version}`;
  const companyRaw = c.companyId ?? c.companyGuid ?? c.company;
  const cid = normalizeCompanyId(companyRaw);
  const tenant = c.tenantId ?? c.tenant ?? c.azureTenantId ?? c.entraTenantId;
  const environment = c.environment ?? c.environmentName ?? c.bcEnvironment;

  if (typeof explicit === "string") {
    let t = explicit.trim().replace(/\/+$/, "");
    const web = parseBcWebClientUrl(t);
    if (web) {
      const host = normalizeBcApiHost("");
      t = `${host}/v2.0/${encodeURIComponent(web.tenant)}/${encodeURIComponent(web.environment)}`;
    }
    if (t.includes("/companies(")) return t;
    if (cid) {
      if (t.includes(apiSegment) && !t.includes("/companies(")) {
        return `${t}/companies(${cid})`;
      }
      if (/\/v2\.0\/[^/]+\/[^/]+/.test(t) && !t.includes("/api/")) {
        return `${t}${apiSegment}/companies(${cid})`;
      }
    }
  }

  if (tenant && environment && cid) {
    const host = normalizeBcApiHost(
      typeof c.apiHost === "string" ? c.apiHost : "",
    );
    return `${host}/v2.0/${encodeURIComponent(String(tenant).trim())}/${encodeURIComponent(String(environment).trim())}${apiSegment}/companies(${cid})`;
  }

  return "";
}

/**
 * URL base OData estándar hasta `…/v2.0/{tenant}/{environment}` (sin API custom ni company).
 * Sirve para `ODataV4/Company`, etc.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {string}
 */
function resolveBcODataEnvironmentRootUrl(cfg) {
  const c = enrichBcConfigFromWebUrl(cfg);
  const tenantRaw = c.tenantId ?? c.tenant ?? c.azureTenantId ?? c.entraTenantId;
  const tenant =
    typeof tenantRaw === "string" ? tenantRaw.trim().replace(/^\{|\}$/g, "") : "";
  const envRaw = c.environment ?? c.environmentName ?? c.bcEnvironment;
  const environment = typeof envRaw === "string" ? envRaw.trim() : "";
  const host = normalizeBcApiHost(typeof c.apiHost === "string" ? c.apiHost : "");
  if (!tenant || !environment) return "";
  return `${host}/v2.0/${encodeURIComponent(tenant)}/${encodeURIComponent(environment)}`;
}

/**
 * Filas de entorno desde Admin API BC.
 *
 * @param {unknown} json
 * @returns {unknown[]}
 */
function extractEnvironmentRowsFromBcJson(json) {
  if (!json || typeof json !== "object") return [];
  const j = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(j.value)) return j.value;
  if (Array.isArray(j.Value)) return j.Value;
  return [];
}

/**
 * @param {unknown} row
 * @returns {{ name: string; type: string; aadTenantId: string; countryCode?: string } | null}
 */
function mapBcEnvironmentRow(row) {
  const r =
    row && typeof row === "object"
      ? /** @type {Record<string, unknown>} */ (row)
      : {};
  const name = String(r.name ?? r.Name ?? "").trim();
  if (!name) return null;
  const type = String(r.type ?? r.Type ?? r.environmentType ?? "").trim();
  const aadTenantId = String(
    r.aadTenantId ?? r.AadTenantId ?? r.tenantId ?? r.TenantId ?? "",
  ).trim();
  const countryCode = String(r.countryCode ?? r.CountryCode ?? "").trim();
  return {
    name,
    type,
    aadTenantId,
    ...(countryCode ? { countryCode } : {}),
  };
}

/**
 * Entornos BC SaaS (Admin API). Verifica OAuth y devuelve nombres para elegir en UI.
 *
 * @param {string} workspaceId
 * @param {{ tenantId?: string }} [overrides]
 * @returns {Promise<Array<{ name: string; type: string; aadTenantId: string; countryCode?: string }>>}
 */
async function listBcEnvironments(workspaceId, overrides = {}) {
  const ctx = await getBusinessCentralIntegration(workspaceId);
  if (!ctx?.integration) {
    throw new HttpError(503, "Integración Business Central no configurada");
  }

  const baseCfg = enrichBcConfigFromWebUrl(
    ctx.integration.configJson && typeof ctx.integration.configJson === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...ctx.integration.configJson })
      : {},
  );
  const ot =
    typeof overrides.tenantId === "string" && overrides.tenantId.trim()
      ? overrides.tenantId.trim()
      : undefined;
  if (ot) baseCfg.tenantId = ot;

  const tenantRaw = baseCfg.tenantId ?? baseCfg.tenant ?? baseCfg.azureTenantId;
  const tenant =
    typeof tenantRaw === "string" ? tenantRaw.trim().replace(/^\{|\}$/g, "") : "";
  if (!tenant) {
    throw new HttpError(
      400,
      "Indica el inquilino (tenant) de Entra para listar entornos BC.",
    );
  }

  const ctxMerged = {
    integration: {
      ...ctx.integration,
      configJson: baseCfg,
    },
  };

  let token = await resolveBcBearerToken(ctxMerged);
  if (!token) {
    throw new HttpError(
      503,
      "Integración BC sin credenciales OAuth (BC_CONNECTOR_* en servidor o opciones avanzadas).",
    );
  }

  const fetchPage = async (fullUrl) =>
    fetch(fullUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

  const parsePageOrThrow = async (res, rawLabel) => {
    const text = stripJsonBom(await res.text());
    /** @type {Record<string, unknown>} */
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      logger.warn(
        { component: "bc-erp-client", rawLabel, snippet: text.slice(0, 280) },
        "BC environments: respuesta no JSON",
      );
      throw new HttpError(
        502,
        "Business Central devolvió un cuerpo que no es JSON al listar entornos.",
      );
    }
    if (!res.ok) {
      const msg = extractBcApiErrorMessage(json, text, res.status);
      throw new HttpError(res.status, msg);
    }
    return json;
  };

  const host = normalizeBcApiHost("");
  /** @type {unknown[]} */
  let rawRows = [];
  let pageUrl = `${host}/admin/v2.28/applications/BusinessCentral/environments`;

  for (let safety = 0; safety < 25; safety += 1) {
    let res = await fetchPage(pageUrl);
    if (res.status === 401) {
      if (ctx.integration.id) invalidateBcTokenCache(ctx.integration.id);
      token = await resolveBcBearerToken(ctxMerged);
      if (!token) {
        throw new HttpError(503, "No se pudo renovar el token BC");
      }
      res = await fetchPage(pageUrl);
    }
    if (res.status === 401) {
      throw new HttpError(
        401,
        "Business Central rechazó el token para Admin Center. Autorizá el client ID de Parseva BC API en Business Central Admin Center > Microsoft Entra Apps y verificá el permiso Application AdminCenter.ReadWrite.All con admin consent."
      );
    }
    const pageJson = await parsePageOrThrow(res, "admin/environments");
    rawRows.push(...extractEnvironmentRowsFromBcJson(pageJson));
    const next =
      typeof pageJson["@odata.nextLink"] === "string"
        ? pageJson["@odata.nextLink"].trim()
        : "";
    pageUrl = next || "";
    if (!pageUrl) break;
  }

  const seen = new Set();
  /** @type {Array<{ name: string; type: string; aadTenantId: string; countryCode?: string }>} */
  const mapped = [];
  for (const row of rawRows) {
    const item = mapBcEnvironmentRow(row);
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    mapped.push(item);
  }

  mapped.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return mapped;
}

/**
 * Lista compañías del entorno BC vía API REST v2.0 (`/api/v2.0/companies`).
 * OData `ODataV4/Company` (NAV.Company) en SaaS a menudo no devuelve GUID útil en `Id`
 * y el `$select` filtra propiedades distintas según versión.
 *
 * @param {string} workspaceId
 * @param {{ tenantId?: string; environment?: string }} [overrides] Opcional: valores del formulario aún no guardados.
 * @returns {Promise<Array<{ id: string; name: string; displayName: string }>>}
 */
async function listBcODataCompanies(workspaceId, overrides = {}) {
  const ctx = await getBusinessCentralIntegration(workspaceId);
  if (!ctx?.integration) {
    throw new HttpError(503, "Integración Business Central no configurada");
  }

  const baseCfg = enrichBcConfigFromWebUrl(
    ctx.integration.configJson && typeof ctx.integration.configJson === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...ctx.integration.configJson })
      : {},
  );
  const ot =
    typeof overrides.tenantId === "string" && overrides.tenantId.trim()
      ? overrides.tenantId.trim()
      : undefined;
  const oe =
    typeof overrides.environment === "string" && overrides.environment.trim()
      ? overrides.environment.trim()
      : undefined;
  if (ot) baseCfg.tenantId = ot;
  if (oe) baseCfg.environment = oe;

  const ctxMerged = {
    integration: {
      ...ctx.integration,
      configJson: baseCfg,
    },
  };

  const root = resolveBcODataEnvironmentRootUrl(baseCfg);
  if (!root) {
    throw new HttpError(
      400,
      "Indica inquilino (tenant) y nombre del entorno BC para listar empresas.",
    );
  }

  let token = await resolveBcBearerToken(ctxMerged);
  if (!token) {
    throw new HttpError(
      503,
      "Integración BC sin credenciales OAuth (BC_CONNECTOR_* en servidor o opciones avanzadas).",
    );
  }

  const fetchPage = async (fullUrl) =>
    fetch(fullUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

  const parsePageOrThrow = async (res, rawLabel) => {
    const text = stripJsonBom(await res.text());
    /** @type {Record<string, unknown>} */
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      logger.warn(
        { component: "bc-erp-client", rawLabel, snippet: text.slice(0, 280) },
        "BC companies: respuesta no JSON",
      );
      throw new HttpError(
        502,
        "Business Central devolvió un cuerpo que no es JSON al listar empresas.",
      );
    }
    if (!res.ok) {
      const msg = extractBcApiErrorMessage(json, text, res.status);
      throw new HttpError(res.status, msg);
    }
    return json;
  };

  /** @type {unknown[]} */
  let rawRows = [];

  let pageUrl = `${root}/api/v2.0/companies`;
  for (let safety = 0; safety < 50; safety += 1) {
    let res = await fetchPage(pageUrl);
    if (res.status === 401) {
      if (ctx.integration.id) invalidateBcTokenCache(ctx.integration.id);
      token = await resolveBcBearerToken(ctxMerged);
      if (!token) {
        throw new HttpError(503, "No se pudo renovar el token BC");
      }
      res = await fetchPage(pageUrl);
    }
    const pageJson = await parsePageOrThrow(res, "api/v2.0/companies");
    rawRows.push(...extractCompanyRowsFromBcJson(pageJson));
    const next =
      typeof pageJson["@odata.nextLink"] === "string"
        ? pageJson["@odata.nextLink"].trim()
        : "";
    pageUrl = next || "";
    if (!pageUrl) break;
  }

  let mapped = rawRows.map(mapBcCompanyRow).filter((x) => x.id.length > 0);

  if (mapped.length === 0 && rawRows.length > 0) {
    logger.warn(
      {
        component: "bc-erp-client",
        sampleKeys:
          rawRows[0] && typeof rawRows[0] === "object"
            ? Object.keys(/** @type {object} */ (rawRows[0])).slice(0, 20)
            : [],
      },
      "BC companies: filas sin GUID reconocible",
    );
  }

  if (mapped.length === 0) {
    rawRows = [];
    let odUrl = `${root}/ODataV4/Company?$top=10000`;
    for (let odSafety = 0; odSafety < 25; odSafety += 1) {
      let res = await fetchPage(odUrl);
      if (res.status === 401) {
        if (ctx.integration.id) invalidateBcTokenCache(ctx.integration.id);
        token = await resolveBcBearerToken(ctxMerged);
        if (!token) {
          throw new HttpError(503, "No se pudo renovar el token BC");
        }
        res = await fetchPage(odUrl);
      }
      const odJson = await parsePageOrThrow(res, "ODataV4/Company");
      rawRows.push(...extractCompanyRowsFromBcJson(odJson));
      const odNext =
        typeof odJson["@odata.nextLink"] === "string"
          ? odJson["@odata.nextLink"].trim()
          : "";
      odUrl = odNext || "";
      if (!odUrl) break;
    }
    mapped = rawRows.map(mapBcCompanyRow).filter((x) => x.id.length > 0);
  }

  const seen = new Set();
  return mapped.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * App Parseva en Entra configurada en proceso (multi-inquilino).
 *
 * @returns {boolean}
 */
function isBcPlatformConnectorConfigured() {
  return Boolean(env.bcConnectorClientId && env.bcConnectorClientSecret);
}

/**
 * Workspace override: app Entra propia del cliente (enterprise).
 *
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
function hasWorkspaceByoOAuth(cfg) {
  const id =
    typeof cfg.oauthClientId === "string" ? cfg.oauthClientId.trim() : "";
  const secret =
    typeof cfg.oauthClientSecret === "string" ? cfg.oauthClientSecret.trim() : "";
  return Boolean(id && secret);
}

/**
 * Token OAuth (client credentials): override BYO en workspace o credenciales globales Parseva.
 *
 * @param {string} integrationId
 * @param {Record<string, unknown>} cfg
 * @returns {Promise<string>}
 */
async function fetchOAuthAccessToken(integrationId, cfg) {
  const tenantRaw =
    (typeof cfg.oauthTenantId === "string" && cfg.oauthTenantId.trim()) ||
    (typeof cfg.tenantId === "string" && cfg.tenantId.trim()) ||
    (typeof cfg.tenant === "string" && cfg.tenant.trim()) ||
    "";

  const useByo = hasWorkspaceByoOAuth(cfg);
  let clientId = "";
  let clientSecret = "";
  if (useByo) {
    clientId = /** @type {string} */ (cfg.oauthClientId).trim();
    clientSecret = /** @type {string} */ (cfg.oauthClientSecret).trim();
  } else {
    clientId = env.bcConnectorClientId;
    clientSecret = env.bcConnectorClientSecret;
  }

  if (!tenantRaw || !clientId || !clientSecret) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        !tenantRaw
          ? "BC: falta GUID del inquilino (tenant) del cliente en la integración"
          : !clientId || !clientSecret
            ? "BC: faltan credenciales OAuth (BC_CONNECTOR_* en servidor o aplicación propia en la integración)"
            : "BC OAuth incompleto",
      )
    );
    err.code = "BC_OAUTH_INCOMPLETE";
    throw err;
  }

  const cacheKey = `${integrationId}::${tenantRaw}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  let pending = tokenInflight.get(cacheKey);
  if (pending) return pending;

  pending = (async () => {
    const tokenUrl = `https://login.microsoftonline.com/${tenantRaw}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: BC_RESOURCE_SCOPE,
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }

    if (!res.ok) {
      const msg =
        json.error_description ||
        json.error ||
        (typeof text === "string" && text.slice(0, 200)) ||
        `OAuth HTTP ${res.status}`;
      logger.warn(
        { component: "bc-erp-client", integrationId, status: res.status },
        "BC OAuth token request failed",
      );
      const err = /** @type {Error & { status?: number }} */ (
        new Error(typeof msg === "string" ? msg : "BC OAuth token error")
      );
      err.status = res.status;
      throw err;
    }

    const accessToken = json.access_token;
    const expiresIn =
      typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
        ? json.expires_in
        : 3600;
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("BC OAuth: respuesta sin access_token");
    }

    const expiresAtMs = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;
    tokenCache.set(cacheKey, { accessToken, expiresAtMs });

    logger.info(
      { component: "bc-erp-client", integrationId, expiresIn },
      "BC OAuth token obtenido",
    );

    return accessToken;
  })();

  tokenInflight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    tokenInflight.delete(cacheKey);
  }
}

/**
 * Bearer para llamadas a BC: OAuth (Parseva multi-tenant o BYO) o token manual.
 *
 * @param {{ integration: import("@prisma/client").IntegrationConnection }} ctx
 * @returns {Promise<string | null>}
 */
async function resolveBcBearerToken(ctx) {
  if (!ctx?.integration) return null;
  const cfg = enrichBcConfigFromWebUrl(
    ctx.integration.configJson && typeof ctx.integration.configJson === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...ctx.integration.configJson })
      : {},
  );

  const manual =
    (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) ||
    (typeof cfg.apiToken === "string" && cfg.apiToken.trim()) ||
    (typeof cfg.accessToken === "string" && cfg.accessToken.trim()) ||
    "";

  if (hasWorkspaceByoOAuth(cfg) || isBcPlatformConnectorConfigured()) {
    try {
      return await fetchOAuthAccessToken(ctx.integration.id, cfg);
    } catch (e) {
      if (manual) {
        logger.warn(
          {
            component: "bc-erp-client",
            err: e instanceof Error ? e.message : String(e),
          },
          "BC OAuth falló; usando Bearer manual configurado",
        );
        return manual;
      }
      throw e;
    }
  }

  return manual || null;
}

/**
 * ¿Hay forma de autenticar contra BC con esta config (OAuth Parseva/BYO o Bearer guardado)?
 *
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
function bcWorkspaceHasResolvableAuth(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  const manual =
    (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) ||
    (typeof cfg.apiToken === "string" && cfg.apiToken.trim()) ||
    (typeof cfg.accessToken === "string" && cfg.accessToken.trim()) ||
    "";
  if (manual) return true;
  const tenantRaw =
    (typeof cfg.oauthTenantId === "string" && cfg.oauthTenantId.trim()) ||
    (typeof cfg.tenantId === "string" && cfg.tenantId.trim()) ||
    (typeof cfg.tenant === "string" && cfg.tenant.trim()) ||
    "";
  if (!tenantRaw) return false;
  if (hasWorkspaceByoOAuth(cfg)) return true;
  if (isBcPlatformConnectorConfigured()) return true;
  return false;
}

/**
 * Resuelve la integración Business Central del workspace (URL base + fila).
 *
 * @param {string} workspaceId
 * @returns {Promise<{ integration: import("@prisma/client").IntegrationConnection; baseUrl: string | null } | null>}
 */
async function getBusinessCentralIntegration(workspaceId) {
  const row = await prisma.integrationConnection.findFirst({
    where: { workspaceId, kind: "business_central" },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  const cfg = enrichBcConfigFromWebUrl(
    row.configJson && typeof row.configJson === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...row.configJson })
      : {},
  );
  const composed = resolveBcApiBaseUrl(cfg);
  const rawLegacy = cfg.baseUrl ?? cfg.apiBaseUrl;
  let legacyTrim =
    typeof rawLegacy === "string" ? rawLegacy.trim().replace(/\/+$/, "") : "";
  if (legacyTrim && parseBcWebClientUrl(legacyTrim)) {
    legacyTrim = "";
  }
  const baseUrl = (composed || legacyTrim || "").trim() || null;
  return { integration: row, baseUrl };
}

/**
 * GET/POST JSON relativo a la base OData del API Publisher (…/companies(id)).
 * Reintenta una vez si BC devuelve 401 (token caducado en caché).
 *
 * @param {string} workspaceId
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function bcErpFetch(workspaceId, path, init = {}) {
  const run = async () => {
    const ctx = await getBusinessCentralIntegration(workspaceId);
    if (!ctx?.baseUrl) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error("Integración Business Central sin baseUrl OData")
      );
      err.code = "BC_NOT_CONFIGURED";
      throw err;
    }
    const bearer = await resolveBcBearerToken(ctx);
    if (!bearer) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          "Integración BC sin credenciales: datos del tenant en la integración y BC_CONNECTOR_* en servidor, o Bearer opcional",
        )
      );
      err.code = "BC_NOT_CONFIGURED";
      throw err;
    }
    const url = `${ctx.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
      Accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${bearer}`,
    };
    return fetch(url, { ...init, headers });
  };

  let res = await run();
  if (res.status === 401) {
    const ctx = await getBusinessCentralIntegration(workspaceId);
    if (ctx?.integration?.id) invalidateBcTokenCache(ctx.integration.id);
    res = await run();
  }
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Response} res
 */
async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/**
 * @param {unknown} raw
 */
function extractODataIngestRow(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.responsePayload === "string" || typeof o.response_payload === "string") return o;
  if (Array.isArray(o.value) && o.value.length > 0) return o.value[0];
  return raw;
}

/**
 * @param {unknown} raw
 */
function ingestResponsePayloadReady(raw) {
  const row = extractODataIngestRow(raw);
  if (!row || typeof row !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (row);
  const payload = r.responsePayload ?? r.response_payload;
  return typeof payload === "string" && payload.trim().startsWith("{");
}

/**
 * @param {string} value
 */
function odataFilterEscape(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * POST OData a la entidad `ingest` (Blob `operations` en Base64).
 * El procesamiento en BC corre en sesión aparte; se hace polling GET hasta `responsePayload`.
 *
 * @param {string} workspaceId
 * @param {{ documentId?: string; idempotencyKey?: string; operations?: unknown[] }} body
 * @param {{ idempotencyKey: string; signal?: AbortSignal }} meta
 * @returns {Promise<{ ok: boolean; status: number; json: unknown }>}
 */
async function bcErpPostIngest(workspaceId, body, meta) {
  const started = Date.now();
  const idempotencyKey = body.idempotencyKey ?? meta.idempotencyKey;
  const timeoutMs = env.bcErpTimeoutMs;

  const assertNotAborted = () => {
    if (meta.signal?.aborted) {
      const err = new Error("BC ingest aborted");
      err.name = "AbortError";
      throw err;
    }
  };

  const runPost = async () => {
    assertNotAborted();
    const ctx = await getBusinessCentralIntegration(workspaceId);
    if (!ctx?.baseUrl) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error("Integración Business Central sin baseUrl OData")
      );
      err.code = "BC_NOT_CONFIGURED";
      throw err;
    }
    const bearer = await resolveBcBearerToken(ctx);
    if (!bearer) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          "Integración BC sin credenciales: datos del tenant en la integración y BC_CONNECTOR_* en servidor, o Bearer opcional",
        )
      );
      err.code = "BC_NOT_CONFIGURED";
      throw err;
    }
    const url = `${ctx.baseUrl}/ingest`;
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${bearer}`,
      "Idempotency-Key": meta.idempotencyKey,
    };
    const payload = {
      documentId: body.documentId ?? "",
      idempotencyKey: body.idempotencyKey ?? meta.idempotencyKey,
      operations: Buffer.from(JSON.stringify(body.operations ?? []), "utf8").toString("base64"),
    };
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: meta.signal,
    });
  };

  let res = await runPost();
  if (res.status === 401) {
    const ctx = await getBusinessCentralIntegration(workspaceId);
    if (ctx?.integration?.id) invalidateBcTokenCache(ctx.integration.id);
    res = await runPost();
  }

  const json = await parseJsonSafe(res);
  if (!res.ok) {
    return { ok: false, status: res.status, json };
  }

  if (ingestResponsePayloadReady(json)) {
    return { ok: true, status: res.status, json };
  }

  const pollIntervalMs = 400;
  while (Date.now() - started < timeoutMs) {
    assertNotAborted();
    await sleep(pollIntervalMs);
    assertNotAborted();
    const filter = encodeURIComponent(`idempotencyKey eq '${odataFilterEscape(idempotencyKey)}'`);
    const getRes = await bcErpFetch(
      workspaceId,
      `/ingest?$filter=${filter}&$top=1&$select=entryNo,idempotencyKey,responsePayload,systemId`,
      { signal: meta.signal },
    );
    const polled = await parseJsonSafe(getRes);
    if (!getRes.ok) {
      return { ok: false, status: getRes.status, json: polled };
    }
    if (ingestResponsePayloadReady(polled)) {
      return { ok: true, status: getRes.status, json: polled };
    }
  }

  return {
    ok: false,
    status: 504,
    json: {
      message:
        "BC ingest: timeout esperando responsePayload (publicá Parseva_App >= 1.0.0.12 y reintentá el sync)",
    },
  };
}

module.exports = {
  BC_RESOURCE_SCOPE,
  resolveBcApiBaseUrl,
  resolveBcODataEnvironmentRootUrl,
  listBcEnvironments,
  listBcODataCompanies,
  getBusinessCentralIntegration,
  resolveBcBearerToken,
  bcWorkspaceHasResolvableAuth,
  invalidateBcTokenCache,
  bcErpFetch,
  bcErpPostIngest,
};
