/**
 * Sugerencias de mapeo extracción → campos BC (heurística + IA opcional).
 *
 * @module services/bc-mapping-suggest
 */

const OpenAI = require("openai");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const HttpError = require("../utils/http-error");

const DEFAULT_MODEL = "gpt-4o-mini";

const USER_JSON_TAIL =
  "\n\nDevuelve SOLO JSON (la palabra json es obligatoria).";

/** @param {string} jsonStr */
function parseExtractionFieldKeys(jsonStr) {
  const trimmed = String(jsonStr || "").trim();
  if (!trimmed) return [];
  try {
    const raw = JSON.parse(trimmed);
    const arr = Array.isArray(raw?.fields) ? raw.fields : [];
    const out = [];
    for (const f of arr) {
      if (!f || typeof f !== "object") continue;
      const k = String(/** @type {{ key?: unknown }} */ (f).key ?? "").trim();
      if (k) out.push(k);
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Coincidencias triviales camelCase ↔ snake sin IA.
 *
 * @param {string[]} extractionKeys
 * @param {Array<{ key: string; displayName: string }>} bcFields
 * @returns {Record<string, string>} bcKey → ruta extracción
 */
function heuristicMappingByBcKey(extractionKeys, bcFields) {
  /** @type {Record<string, string>} */
  const out = {};
  const exSet = new Set(extractionKeys);
  const exNorm = extractionKeys.map((k) => ({ k, n: normalizeKey(k) }));

  for (const bf of bcFields) {
    const bk = String(bf.key || "").trim();
    if (!bk) continue;
    if (exSet.has(bk)) {
      out[bk] = bk;
      continue;
    }
    const bn = normalizeKey(bk);
    let best = "";
    let bestScore = 0;
    for (const { k, n } of exNorm) {
      if (!n) continue;
      let score = 0;
      if (n === bn) score = 100;
      else if (n.includes(bn) || bn.includes(n)) score = 70;
      else {
        const a = new Set(bn.match(/.{2,}/g) || []);
        const b = new Set(n.match(/.{2,}/g) || []);
        let overlap = 0;
        for (const x of a) if (b.has(x)) overlap++;
        if (overlap > 0) score = Math.min(55, 20 + overlap * 8);
      }
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (bestScore >= 55) out[bk] = best;
  }
  return out;
}

function getOpenAIClient() {
  if (!env.openaiApiKey) return null;
  return new OpenAI({ apiKey: env.openaiApiKey });
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const chunks = [];
  for (const item of response?.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) {
      if (c.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
    }
  }
  return chunks.join("").trim();
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * @param {string} workspaceId
 * @param {{
 *   documentTypeId: string;
 *   bcTargetId: string;
 *   strategy?: string;
 *   extractionSchemaJson?: string;
 * }} input
 */
async function suggestBcFieldMapping(workspaceId, input) {
  const documentTypeId = String(input?.documentTypeId || "").trim();
  const bcTargetId = String(input?.bcTargetId || "").trim();
  const strategy = String(input?.strategy || "auto").toLowerCase();
  const overrideRaw =
    typeof input?.extractionSchemaJson === "string"
      ? input.extractionSchemaJson.trim()
      : "";

  if (!documentTypeId || !bcTargetId) {
    throw new HttpError(400, "documentTypeId y bcTargetId son obligatorios");
  }

  const docType = await prisma.documentType.findFirst({
    where: { id: documentTypeId, workspaceId },
  });
  if (!docType) throw new HttpError(404, "Tipo documental no encontrado");

  const target = await prisma.bcTarget.findFirst({
    where: { id: bcTargetId, workspaceId },
    include: { fields: { orderBy: { key: "asc" } } },
  });
  if (!target) throw new HttpError(404, "Destino BC no encontrado");

  const schemaFromDb =
    docType.aiExtractionSchema != null
      ? JSON.stringify(docType.aiExtractionSchema)
      : "";

  /** @type {string[]} */
  let extractionKeys = [];
  /** @type {"body" | "database" | "none"} */
  let schemaSource = "none";
  if (overrideRaw) {
    extractionKeys = parseExtractionFieldKeys(overrideRaw);
    if (extractionKeys.length > 0) schemaSource = "body";
  }
  if (extractionKeys.length === 0 && schemaFromDb) {
    extractionKeys = parseExtractionFieldKeys(schemaFromDb);
    if (extractionKeys.length > 0) schemaSource = "database";
  }

  const bcFields = (target.fields || []).map((f) => ({
    key: f.key,
    displayName: f.displayName,
    dataType: f.dataType,
    required: f.required === true,
  }));

  if (extractionKeys.length === 0) {
    return {
      mappingByBcKey: {},
      extractionKeys: [],
      bcFieldKeys: bcFields.map((f) => f.key),
      source: "none",
      schemaSource,
      notes:
        "No hay campos en el esquema de extracción. Definilos en Extracción IA, guardá el tipo, o enviá el JSON del borrador (extractionSchemaJson) al sugerir.",
      strategy,
    };
  }

  const heuristic = heuristicMappingByBcKey(extractionKeys, bcFields);
  let source = "heuristic";
  let notes = "";
  /** @type {Record<string, string>} */
  let mappingByBcKey = { ...heuristic };

  if (strategy === "heuristic") {
    return {
      mappingByBcKey,
      extractionKeys,
      bcFieldKeys: bcFields.map((f) => f.key),
      source,
      schemaSource,
      notes: notes || "Solo coincidencias por nombre (sin llamada a IA).",
      strategy,
    };
  }

  const wantAi = strategy === "ai" || strategy === "auto";
  const client = getOpenAIClient();

  if (strategy === "ai" && !client) {
    throw new HttpError(
      503,
      "La sugerencia con IA no está disponible: falta OPENAI_API_KEY en el servidor."
    );
  }

  if (wantAi && client) {
    const model = env.openaiModel || DEFAULT_MODEL;
    const instructions = `Sos un integrador ERP (Business Central) y automatizacion documental.

Te dan:
1) Lista de RUTAS o claves del JSON de extraccion (Parseva) — solo podes usar estas cadenas exactas como "extractPath".
2) Lista de campos destino BC con key camelCase (API Parseva / extension).

Tarea: para cada campo BC que tenga sentido en facturas / compras, elegi como maximo UNA ruta de extraccion que mejor represente el mismo dato semantico.
Si no hay match razonable, usa extractPath vacio "".

Reglas:
- "extractPath" debe ser exactamente uno de los valores permitidos en la lista de extraccion, o cadena vacia.
- "bcKey" debe ser exactamente uno de los keys BC permitidos.
- No inventes rutas nuevas.
- Prioriza obligatorios BC (required) si hay ambiguedad.
- Respondé SOLO JSON: { "mappings": [ { "bcKey": "...", "extractPath": "..." } ] }`;

    const userText = `Tipo documental: ${docType.displayName} (key=${docType.key})
Destino BC: ${target.displayName} (targetKey=${target.key})

Rutas de extraccion permitidas (JSON paths / keys):
${JSON.stringify(extractionKeys)}

Campos BC:
${JSON.stringify(bcFields)}

Generá el arreglo "mappings".${USER_JSON_TAIL}`;

    try {
      const response = await client.responses.create({
        model,
        instructions,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: userText.slice(0, 12000) }],
          },
        ],
        temperature: 0.2,
        text: { format: { type: "json_object" } },
        store: false,
        max_output_tokens: 2048,
      });
      const raw = extractOutputText(response);
      const parsed = safeJsonParse(raw);
      const rows = Array.isArray(parsed?.mappings) ? parsed.mappings : [];
      const allowedBc = new Set(bcFields.map((f) => f.key));
      const allowedEx = new Set(extractionKeys);
      /** @type {Record<string, string>} */
      const aiMap = {};
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const bcKey = String(row.bcKey || "").trim();
        const extractPath = String(row.extractPath || "").trim();
        if (!allowedBc.has(bcKey)) continue;
        if (extractPath && !allowedEx.has(extractPath)) continue;
        aiMap[bcKey] = extractPath;
      }
      if (Object.keys(aiMap).length > 0) {
        mappingByBcKey = { ...heuristic, ...aiMap };
        source = "openai";
        notes = "Combinado con sugerencias del modelo (revisá obligatorios BC).";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes = `IA no disponible o falló (${msg.slice(0, 200)}); se usó heurística.`;
    }
  } else if (strategy === "auto" && !client) {
    notes = "OpenAI no configurado en el servidor; se usó solo heuristica.";
  }

  return {
    mappingByBcKey,
    extractionKeys,
    bcFieldKeys: bcFields.map((f) => f.key),
    source,
    schemaSource,
    notes: notes || (source === "openai" ? "Revisá obligatorios BC antes de guardar." : ""),
    strategy: source === "openai" ? `${strategy}+openai` : strategy,
  };
}

module.exports = {
  suggestBcFieldMapping,
  parseExtractionFieldKeys,
  heuristicMappingByBcKey,
};
