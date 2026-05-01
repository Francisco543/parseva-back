/**
 * @file Cliente para Azure Document Intelligence (REST API, modelo `prebuilt-layout`).
 * Usa el recurso como motor OCR + layout: devuelve páginas con palabras y polígonos,
 * tablas y full text. La extracción semántica de campos se hace después con un LLM
 * sobre el texto OCR (ver `document-extraction.service.js`).
 *
 * Docs: https://learn.microsoft.com/azure/ai-services/document-intelligence/
 *
 * @module services/azure-doc-intelligence
 */

const env = require("../config/env");
const { logger } = require("../lib/logger");
const HttpError = require("../utils/http-error");

/**
 * Forma compacta del layout que se persiste en `DocumentLayout.pages`.
 *
 * @typedef {object} OcrWord
 * @property {string} c   contenido (texto de la palabra)
 * @property {number[]} p polígono [x1,y1,x2,y2,x3,y3,x4,y4] en unidades de la página
 * @property {number} cf  confidence 0..1
 * @property {number} s   span.offset en `fullText`
 * @property {number} l   span.length
 *
 * @typedef {object} OcrLine
 * @property {string} c
 * @property {number[]} p
 *
 * @typedef {object} OcrPage
 * @property {number} n   pageNumber (1-based)
 * @property {number} w   width
 * @property {number} h   height
 * @property {string} u   unit ("inch" | "pixel")
 * @property {number} a   angle
 * @property {OcrWord[]} words
 * @property {OcrLine[]} lines
 *
 * @typedef {object} OcrTableCell
 * @property {number} r row index
 * @property {number} c col index
 * @property {string} content
 * @property {number[]} polygon
 * @property {number} page
 *
 * @typedef {object} OcrTable
 * @property {number} rows
 * @property {number} cols
 * @property {OcrTableCell[]} cells
 *
 * @typedef {object} OcrLayout
 * @property {string} modelId
 * @property {string} apiVersion
 * @property {number} pageCount
 * @property {OcrPage[]} pages
 * @property {OcrTable[]} tables
 * @property {string} fullText
 */

/** Conjunto de tipos MIME aceptados por DI 2024-11-30 (subset usado por la app). */
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/bmp",
  "image/heif",
]);

function isConfigured() {
  return Boolean(env.azureDiEndpoint && env.azureDiKey);
}

function buildAnalyzeUrl(modelId) {
  const id = modelId || env.azureDiModelId || "prebuilt-layout";
  const params = new URLSearchParams({
    "api-version": env.azureDiApiVersion,
    outputContentFormat: "text",
  });
  return `${env.azureDiEndpoint}/documentintelligence/documentModels/${encodeURIComponent(id)}:analyze?${params.toString()}`;
}

function pickMimeType(contentType) {
  const ct = String(contentType || "application/pdf").toLowerCase().split(";")[0].trim();
  if (ALLOWED_MIME.has(ct)) return ct;
  return "application/pdf";
}

/**
 * Compactación del polygon de Azure DI.
 * En 2024-11-30 viene como array plano de 8 números: [x1,y1,...,x4,y4] (en unidades de la página).
 *
 * @param {unknown} poly
 * @returns {number[]}
 */
function normalizePolygon(poly) {
  if (!Array.isArray(poly)) return [];
  const flat = [];
  for (const v of poly) {
    if (typeof v === "number" && Number.isFinite(v)) {
      flat.push(Math.round(v * 1000) / 1000);
    } else if (v && typeof v === "object") {
      const x = typeof v.x === "number" ? v.x : null;
      const y = typeof v.y === "number" ? v.y : null;
      if (x != null && y != null) {
        flat.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
      }
    }
  }
  return flat;
}

/**
 * Normaliza la respuesta cruda de DI a la forma compacta `OcrLayout`.
 *
 * @param {Record<string, unknown>} analyzeResult
 * @param {{ modelId: string, apiVersion: string }} meta
 * @returns {OcrLayout}
 */
function normalizeAnalyzeResult(analyzeResult, meta) {
  const result =
    analyzeResult && typeof analyzeResult === "object" ? analyzeResult : {};
  const fullText = typeof result.content === "string" ? result.content : "";
  const rawPages = Array.isArray(result.pages) ? result.pages : [];
  const rawTables = Array.isArray(result.tables) ? result.tables : [];

  /** @type {OcrPage[]} */
  const pages = rawPages.map((p, idx) => {
    const words = Array.isArray(p.words) ? p.words : [];
    const lines = Array.isArray(p.lines) ? p.lines : [];
    return {
      n: typeof p.pageNumber === "number" ? p.pageNumber : idx + 1,
      w: typeof p.width === "number" ? p.width : 0,
      h: typeof p.height === "number" ? p.height : 0,
      u: typeof p.unit === "string" ? p.unit : "inch",
      a: typeof p.angle === "number" ? p.angle : 0,
      words: words.map((w) => ({
        c: typeof w.content === "string" ? w.content : "",
        p: normalizePolygon(w.polygon),
        cf: typeof w.confidence === "number" ? w.confidence : 0,
        s:
          w.span && typeof w.span.offset === "number"
            ? w.span.offset
            : Array.isArray(w.spans) && w.spans[0] && typeof w.spans[0].offset === "number"
              ? w.spans[0].offset
              : 0,
        l:
          w.span && typeof w.span.length === "number"
            ? w.span.length
            : Array.isArray(w.spans) && w.spans[0] && typeof w.spans[0].length === "number"
              ? w.spans[0].length
              : (typeof w.content === "string" ? w.content.length : 0),
      })),
      lines: lines.map((ln) => ({
        c: typeof ln.content === "string" ? ln.content : "",
        p: normalizePolygon(ln.polygon),
      })),
    };
  });

  /** @type {OcrTable[]} */
  const tables = rawTables.map((t) => ({
    rows: typeof t.rowCount === "number" ? t.rowCount : 0,
    cols: typeof t.columnCount === "number" ? t.columnCount : 0,
    cells: Array.isArray(t.cells)
      ? t.cells.map((cell) => {
          const region = Array.isArray(cell.boundingRegions) ? cell.boundingRegions[0] : null;
          return {
            r: typeof cell.rowIndex === "number" ? cell.rowIndex : 0,
            c: typeof cell.columnIndex === "number" ? cell.columnIndex : 0,
            content: typeof cell.content === "string" ? cell.content : "",
            polygon: region ? normalizePolygon(region.polygon) : [],
            page: region && typeof region.pageNumber === "number" ? region.pageNumber : 1,
          };
        })
      : [],
  }));

  return {
    modelId: meta.modelId,
    apiVersion: meta.apiVersion,
    pageCount: pages.length,
    pages,
    tables,
    fullText,
  };
}

/**
 * Analiza un documento con `prebuilt-layout` (o el modelo especificado).
 * Maneja el flujo asíncrono (POST → 202 + Operation-Location → polling GET).
 *
 * @param {Buffer} buffer
 * @param {{ modelId?: string, contentType?: string }} [opts]
 * @returns {Promise<OcrLayout>}
 */
async function analyzeLayout(buffer, opts = {}) {
  if (!isConfigured()) {
    const err = new Error("Azure Document Intelligence no está configurado");
    err.code = "AZURE_DI_NOT_CONFIGURED";
    throw err;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("analyzeLayout requiere un Buffer no vacío");
  }

  const modelId = opts.modelId || env.azureDiModelId || "prebuilt-layout";
  const apiVersion = env.azureDiApiVersion;
  const url = buildAnalyzeUrl(modelId);
  const contentType = pickMimeType(opts.contentType);

  const startedAt = Date.now();
  const submitRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Ocp-Apim-Subscription-Key": env.azureDiKey,
      Accept: "application/json",
    },
    body: buffer,
  });

  if (submitRes.status !== 202) {
    const text = await submitRes.text().catch(() => "");
    logger.warn(
      {
        component: "azure-di",
        status: submitRes.status,
        body: text.slice(0, 600),
      },
      "Azure DI submit falló"
    );
    throw new HttpError(
      submitRes.status >= 400 && submitRes.status < 600 ? submitRes.status : 502,
      `Azure DI submit error (${submitRes.status})`,
      text.slice(0, 600) || undefined
    );
  }

  const opLoc = submitRes.headers.get("operation-location");
  if (!opLoc) {
    throw new HttpError(502, "Azure DI no devolvió Operation-Location");
  }

  const interval = env.azureDiPollIntervalMs;
  const maxMs = env.azureDiMaxPollMs;
  let lastBody = null;

  while (Date.now() - startedAt < maxMs) {
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetch(opLoc, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": env.azureDiKey,
        Accept: "application/json",
      },
    });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      logger.warn(
        { component: "azure-di", status: pollRes.status, body: text.slice(0, 400) },
        "Azure DI polling falló"
      );
      throw new HttpError(
        502,
        `Azure DI polling error (${pollRes.status})`,
        text.slice(0, 400) || undefined
      );
    }
    const body = await pollRes.json();
    lastBody = body;
    const status = String(body?.status || "").toLowerCase();
    if (status === "succeeded") {
      const analyzeResult = body.analyzeResult || body.result || {};
      const layout = normalizeAnalyzeResult(analyzeResult, { modelId, apiVersion });
      logger.info(
        {
          component: "azure-di",
          pages: layout.pageCount,
          chars: layout.fullText.length,
          ms: Date.now() - startedAt,
        },
        "Azure DI layout extraído"
      );
      return layout;
    }
    if (status === "failed") {
      const errInfo = body?.error || {};
      const message = errInfo.message || "Azure DI análisis falló";
      throw new HttpError(502, message, JSON.stringify(errInfo).slice(0, 600));
    }
  }

  logger.warn(
    { component: "azure-di", lastStatus: lastBody?.status },
    "Azure DI polling timeout"
  );
  throw new HttpError(504, "Azure DI: timeout esperando el análisis");
}

/**
 * Localiza un fragmento textual (`evidence`) en una `OcrLayout` y devuelve los
 * spans correspondientes (página + polígono unión de las palabras matched).
 *
 * Estrategia:
 *  1. Busca el snippet en `fullText` por substring case-insensitive (con espacios normalizados).
 *  2. Si encuentra el offset, mapea esos `[start, end)` a las palabras cuyo `[s, s+l)` interseca el rango.
 *  3. Devuelve un span por cada página con el polígono "bounding box" (rect axis-aligned) que cubre todas
 *     las palabras encontradas en esa página.
 *
 * @param {OcrLayout | null | undefined} layout
 * @param {string} evidence
 * @returns {Array<{ page: number, polygon: number[], evidenceText: string }>}
 */
function findSpansForEvidence(layout, evidence) {
  if (!layout || !evidence || typeof evidence !== "string") return [];
  const ev = evidence.trim();
  if (!ev) return [];
  const text = String(layout.fullText || "");
  if (!text) return [];

  const normalize = (s) => s.replace(/\s+/g, " ").toLowerCase();
  const haystack = normalize(text);
  const needle = normalize(ev);
  if (!needle) return [];

  let matchIdx = haystack.indexOf(needle);
  if (matchIdx < 0) {
    // Fallback: probamos primeros 4 tokens (útil para snippets largos del LLM)
    const tokens = needle.split(" ").filter(Boolean).slice(0, 6);
    if (tokens.length === 0) return [];
    const partial = tokens.join(" ");
    matchIdx = haystack.indexOf(partial);
    if (matchIdx < 0) return [];
  }

  // Reconstruimos el offset original mapeando `haystack` → `text` con un cursor.
  // Como normalize() solo colapsa whitespace y baja mayúsculas, ambas cadenas
  // mantienen el mismo orden de caracteres no-whitespace; aproximamos por una pasada
  // sincronizada.
  let origStart = -1;
  let origEnd = -1;
  let normCursor = 0;
  let prevSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isSpace = /\s/.test(ch);
    let normChar = "";
    if (isSpace) {
      if (!prevSpace) normChar = " ";
      prevSpace = true;
    } else {
      normChar = ch.toLowerCase();
      prevSpace = false;
    }
    if (normChar) {
      if (normCursor === matchIdx && origStart < 0) origStart = i;
      normCursor++;
      if (normCursor === matchIdx + needle.length) {
        origEnd = i + 1;
        break;
      }
    }
  }
  if (origStart < 0) return [];
  if (origEnd < 0) origEnd = text.length;

  /** @type {Map<number, number[]>} */
  const polygonsByPage = new Map();
  for (const page of layout.pages || []) {
    for (const w of page.words || []) {
      const wEnd = (w.s || 0) + (w.l || 0);
      if (wEnd <= origStart) continue;
      if ((w.s || 0) >= origEnd) break;
      const arr = polygonsByPage.get(page.n) || [];
      arr.push(...(w.p || []));
      polygonsByPage.set(page.n, arr);
    }
  }

  const result = [];
  for (const [page, coords] of polygonsByPage) {
    if (coords.length < 2) continue;
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < coords.length; i += 2) {
      const x = coords[i];
      const y = coords[i + 1];
      if (typeof x !== "number" || typeof y !== "number") continue;
      if (x < xMin) xMin = x;
      if (y < yMin) yMin = y;
      if (x > xMax) xMax = x;
      if (y > yMax) yMax = y;
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) continue;
    result.push({
      page,
      polygon: [
        Math.round(xMin * 1000) / 1000,
        Math.round(yMin * 1000) / 1000,
        Math.round(xMax * 1000) / 1000,
        Math.round(yMin * 1000) / 1000,
        Math.round(xMax * 1000) / 1000,
        Math.round(yMax * 1000) / 1000,
        Math.round(xMin * 1000) / 1000,
        Math.round(yMax * 1000) / 1000,
      ],
      evidenceText: text.slice(origStart, origEnd).slice(0, 240),
    });
  }
  return result;
}

/**
 * Construye un texto OCR enriquecido con marcadores de página, listo para meter
 * como "input_text" en un LLM. Trunca a `maxChars` para controlar tokens.
 *
 * @param {OcrLayout | null | undefined} layout
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
function buildPaginatedOcrText(layout, opts = {}) {
  if (!layout) return "";
  const max = typeof opts.maxChars === "number" ? opts.maxChars : 24000;
  const fullText = String(layout.fullText || "");
  if (!fullText) return "";

  // Si Azure DI ya devuelve `content` con sub-páginas separadas por \f,
  // lo respetamos. Si no, reconstruimos páginas por word.spans.
  if (fullText.includes("\f")) {
    const chunks = fullText.split("\f").map((part, idx) => `[Página ${idx + 1}]\n${part.trim()}`);
    return chunks.join("\n\n").slice(0, max);
  }

  const out = [];
  for (const page of layout.pages || []) {
    const lines = (page.lines || []).map((ln) => ln.c).filter((s) => s && s.trim());
    if (lines.length === 0) continue;
    out.push(`[Página ${page.n}]\n${lines.join("\n")}`);
  }
  return out.join("\n\n").slice(0, max) || fullText.slice(0, max);
}

module.exports = {
  isConfigured,
  analyzeLayout,
  normalizeAnalyzeResult,
  findSpansForEvidence,
  buildPaginatedOcrText,
};
