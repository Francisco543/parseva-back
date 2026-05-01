const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const env = require("../config/env");
const {
  buildPaginatedOcrText,
  findSpansForEvidence,
} = require("./azure-doc-intelligence.service");

const DEFAULT_MODEL = "gpt-4o-mini";

const USER_JSON_TAIL =
  "\n\nDevuelve SOLO JSON (la palabra json es obligatoria).";

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
 * @param {string|null|undefined} modelKey
 * @param {string[]} allowed
 * @returns {{ key: string | null, rawModelKey?: string, remapped: boolean }}
 */
function normalizeClassificationKey(modelKey, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return { key: null, remapped: false };
  }
  const k = typeof modelKey === "string" ? modelKey.trim() : "";
  if (allowed.includes(k)) return { key: k, remapped: false };
  const lower = k.toLowerCase();
  const caseInsensitive = allowed.find((a) => a.toLowerCase() === lower);
  if (caseInsensitive) return { key: caseInsensitive, rawModelKey: k, remapped: true };
  if (allowed.includes("other")) return { key: "other", rawModelKey: k || undefined, remapped: true };
  return { key: null, rawModelKey: k || undefined, remapped: true };
}

function buildClassifierTypeLines(documentTypes, allowedKeys) {
  const list =
    Array.isArray(documentTypes) && documentTypes.length
      ? documentTypes.filter((t) => allowedKeys.includes(t.key))
      : allowedKeys.map((key) => ({ key, displayName: key, hint: null }));

  return list.map((t) => {
    const hint =
      typeof t.hint === "string" && t.hint.trim()
        ? t.hint.trim().slice(0, 280)
        : null;
    const label = (t.displayName || t.key || "").trim() || t.key;
    return hint
      ? `- key: "${t.key}" | nombre: ${label} | guía: ${hint}`
      : `- key: "${t.key}" | nombre: ${label}`;
  });
}

/**
 * Clasifica el PDF en una key de DocumentType del workspace (no hay catálogo fijo de negocio).
 *
 * @param {{
 *   fileName: string,
 *   pdfBuffer: Buffer,
 *   contextText: string,
 *   allowedTypeKeys: string[],
 *   documentTypes?: Array<{ key: string, displayName: string, hint?: string | null }>,
 * }} input
 * @param {{ model?: string }} [options]
 * @returns {Promise<{ key: string | null, confidence: number, notes: string | null, model: string, rawModelKey?: string }>}
 */
async function classifyDocument(input, options = {}) {
  const model = options.model || env.openaiPdfModel || env.openaiModel || DEFAULT_MODEL;
  const allowed = Array.isArray(input.allowedTypeKeys)
    ? [...new Set(input.allowedTypeKeys.filter((k) => typeof k === "string" && k.trim()))].map((k) => k.trim())
    : [];

  if (allowed.length === 0) {
    return {
      key: null,
      confidence: 0,
      notes: "Sin tipos documentales habilitados en el workspace",
      model,
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    const key = allowed.includes("other") ? "other" : allowed[0];
    return {
      key,
      confidence: 0.15,
      notes: "OpenAI no configurado; asignación por política mínima",
      model,
    };
  }

  const typeLines = buildClassifierTypeLines(input.documentTypes || [], allowed).join("\n");

  const instructions = `Sos un clasificador de DOCUMENTOS (PDF) adjuntos a correos electrónicos.

El workspace del cliente define los ÚNICOS tipos válidos. Debés elegir exactamente UN tipo.
La salida JSON debe usar el campo "key" IGUAL (mismo texto, sensible a mayúsculas) a una de las keys listadas abajo.

Tipos permitidos:
${typeLines}

Reglas:
- Usá el contenido visual/textual del PDF, el nombre del archivo y el contexto del correo.
- Los tipos pueden ser de cualquier dominio que el cliente haya configurado: facturación, logística, RRHH (CV, contratos), legal, médico, etc.
- Si el documento no encaja claramiente en ningún tipo específico, usá el tipo genérico con key "other" SOLO si aparece en la lista; si no existe "other", elegí el tipo más cercano y bajá la confianza.
- No inventes keys: "key" debe ser una de: ${allowed.map((k) => `"${k}"`).join(", ")}.

Respondé SOLO con JSON:
{ "key": string, "confidence": number, "notes": string | null }
- confidence entre 0 y 1
- notes breve en español (opcional)`;

  const file = await client.files.create({
    file: await toFile(input.pdfBuffer, input.fileName || "documento.pdf"),
    purpose: "user_data",
  });

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file_id: file.id },
            {
              type: "input_text",
              text: `Contexto del mensaje (asunto y cuerpo):\n${(input.contextText || "").slice(0, 8000)}${USER_JSON_TAIL}`,
            },
          ],
        },
      ],
      temperature: 0.15,
      text: { format: { type: "json_object" } },
      store: false,
      max_output_tokens: 512,
    });

    const raw = extractOutputText(response);
    const parsed = safeJsonParse(raw) || {};
    const rawKey = typeof parsed.key === "string" ? parsed.key.trim() : "";
    let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.45;
    let notes = parsed.notes != null ? String(parsed.notes).slice(0, 800) : null;

    const { key: normalizedKey, rawModelKey, remapped } = normalizeClassificationKey(rawKey, allowed);
    if (remapped) {
      confidence = Math.min(confidence, 0.55);
      const extra =
        normalizedKey === "other"
          ? ` Modelo sugirió "${rawModelKey || rawKey}"; se usó "other".`
          : normalizedKey
            ? ` Modelo sugirió "${rawModelKey || rawKey}"; se normalizó a "${normalizedKey}".`
            : ` Clave no válida: "${rawModelKey || rawKey}".`;
      notes = `${notes || ""}${extra}`.trim();
    }

    return {
      key: normalizedKey,
      confidence,
      notes,
      model,
      ...(rawModelKey && normalizedKey !== rawModelKey ? { rawModelKey } : {}),
    };
  } finally {
    await client.files.delete(file.id).catch(() => {});
  }
}

/** Evita colisionar con metadatos que guardamos en extractionJson */
const RESERVED_EXTRACTION_JSON_KEYS = new Set([
  "classification",
  "typeExtraction",
  "model",
  "raw",
  "extraction_input_mode",
  "extractionConfidence",
  "extractionNotes",
]);

const MAX_SCHEMA_FIELDS = 48;

/**
 * Normaliza aiExtractionSchema guardado en DocumentType.
 *
 * @param {unknown} raw
 * @returns {{ fields: Array<{ key: string, label: string, type: string, description: string, required: boolean }> }}
 */
function normalizeAiExtractionSchema(raw) {
  const fields = [];
  if (raw == null) return { fields };
  const obj = typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const arr = obj && Array.isArray(obj.fields) ? obj.fields : null;
  if (!arr) return { fields };
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key || RESERVED_EXTRACTION_JSON_KEYS.has(key)) continue;
    const tRaw = typeof item.type === "string" ? item.type.trim().toLowerCase() : "string";
    const type = ["string", "number", "boolean", "array", "object"].includes(tRaw) ? tRaw : "string";
    fields.push({
      key,
      label: typeof item.label === "string" ? item.label.trim() : "",
      type,
      description:
        typeof item.description === "string" ? item.description.trim().slice(0, 600) : "",
      required: item.required === true,
    });
    if (fields.length >= MAX_SCHEMA_FIELDS) break;
  }
  return { fields };
}

function buildFieldLinesForPrompt(fields) {
  return fields
    .map((f) => {
      const label = f.label ? ` | etiqueta: ${f.label}` : "";
      const desc = f.description ? ` | instruccion: ${f.description}` : "";
      const req = f.required ? " | obligatorio: si" : "";
      return `- "${f.key}" (tipo: ${f.type})${label}${desc}${req}`;
    })
    .join("\n");
}

/**
 * Extrae valores según el esquema del tipo documental (PDF + contexto de correo).
 *
 * @param {{
 *   fileName: string,
 *   pdfBuffer: Buffer,
 *   contextText: string,
 *   documentTypeKey: string,
 *   documentTypeLabel: string,
 *   schema: { fields: Array<{ key: string, label: string, type: string, description: string, required: boolean }> },
 * }} input
 * @param {{ model?: string }} [options]
 * @returns {Promise<{ fields: Record<string, unknown>, confidence: number, notes: string | null, model: string, raw: string | null }>}
 */
async function extractFieldsBySchema(input, options = {}) {
  const model = options.model || env.openaiPdfModel || env.openaiModel || DEFAULT_MODEL;
  const schema = input.schema && Array.isArray(input.schema.fields) ? input.schema : { fields: [] };
  const { fields } = schema;

  if (fields.length === 0) {
    return {
      fields: {},
      confidence: 0,
      notes: "Sin campos definidos en aiExtractionSchema",
      model,
      raw: null,
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    return {
      fields: {},
      confidence: 0,
      notes: "OpenAI no configurado",
      model,
      raw: null,
    };
  }

  const typeKey = String(input.documentTypeKey || "documento");
  const typeLabel = String(input.documentTypeLabel || typeKey);
  const fieldLines = buildFieldLinesForPrompt(fields);

  const instructions = `Sos un extractor de datos de DOCUMENTOS PDF recibidos por correo.

Tipo documental del workspace: "${typeKey}" (${typeLabel}).

Debés leer el PDF y el contexto del mensaje, y devolver SOLO un JSON con:
1) "extractionConfidence": número entre 0 y 1 (qué tan seguro estás de la extracción global)
2) "extractionNotes": string breve en español o null (opcional, incoherencias o vacíos)
3) Un campo por cada clave listada abajo, usando exactamente esa clave (mismo texto, sensible a mayúsculas).
   - Tipos: "string" → string o null; "number" → número o null; "boolean" → true/false o null; "array" → array JSON o []; "object" → objeto JSON o null.
   - Si no encontrás un dato, usá null (o [] para array vacío si corresponde).
   - No inventes datos que no estén en el documento o en el contexto razonable del correo.

Campos a extraer:
${fieldLines}

No incluyás otras claves de nivel superior aparte de extractionConfidence, extractionNotes y las claves listadas arriba.`;

  const file = await client.files.create({
    file: await toFile(input.pdfBuffer, input.fileName || "documento.pdf"),
    purpose: "user_data",
  });

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file_id: file.id },
            {
              type: "input_text",
              text: `Contexto del mensaje (asunto y cuerpo):\n${(input.contextText || "").slice(0, 8000)}${USER_JSON_TAIL}`,
            },
          ],
        },
      ],
      temperature: 0.1,
      text: { format: { type: "json_object" } },
      store: false,
      max_output_tokens: 4096,
    });

    const raw = extractOutputText(response);
    const parsed = safeJsonParse(raw) || {};
    let confidence =
      typeof parsed.extractionConfidence === "number" ? parsed.extractionConfidence : 0.45;
    confidence = Math.max(0, Math.min(1, confidence));
    let notes =
      parsed.extractionNotes != null ? String(parsed.extractionNotes).slice(0, 1200) : null;

    const out = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(parsed, f.key)) {
        out[f.key] = parsed[f.key];
      } else {
        out[f.key] = null;
      }
    }

    return {
      fields: out,
      confidence,
      notes,
      model,
      raw: raw || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fields: Object.fromEntries(fields.map((f) => [f.key, null])),
      confidence: 0,
      notes: `Error de extracción: ${msg.slice(0, 400)}`,
      model,
      raw: null,
    };
  } finally {
    await client.files.delete(file.id).catch(() => {});
  }
}

/**
 * Sugiere un objeto { fields: [...] } para aiExtractionSchema segun el tipo documental (solo texto, sin PDF).
 *
 * @param {{
 *   key: string,
 *   displayName: string,
 *   classifierHint?: string | null,
 *   userHint?: string | null,
 *   baseSchema?: unknown,
 * }} input
 * @param {{ model?: string }} [options]
 * @returns {Promise<{ fields: Array<{ key: string, label: string, type: string, description: string, required: boolean }> }>}
 */
async function suggestAiExtractionSchema(input, options = {}) {
  const model = options.model || env.openaiModel || DEFAULT_MODEL;
  const client = getOpenAIClient();
  if (!client) {
    const e = new Error("OpenAI no configurado");
    e.code = "OPENAI_NOT_CONFIGURED";
    throw e;
  }

  const key = String(input.key || "documento").slice(0, 80);
  const displayName = String(input.displayName || key).slice(0, 160);
  const classifierHint = String(input.classifierHint || "").trim().slice(0, 800);
  const userHint = String(input.userHint || "").trim().slice(0, 2000);

  let baseBlock = "";
  const base = input.baseSchema;
  if (base != null && typeof base === "object") {
    try {
      const s = JSON.stringify(base).slice(0, 4500);
      baseBlock = `\nEsquema base (conserva o mejora estas claves si siguen siendo utiles; podes agregar o quitar campos segun criterio profesional):\n${s}`;
    } catch {
      /* ignore */
    }
  }

  const instructions = `Sos un experto en automatizacion documental y extraccion estructurada desde PDFs y correos.

Tu tarea: proponer una lista de CAMPOS a extraer con IA para un tipo documental de un workspace empresarial.

Reglas:
- Entre 6 y 18 campos, salvo que el contexto pida muy pocos (ej. tipo trivial).
- Cada campo: "key" en snake_case, ASCII (a-z, 0-9, guiones bajos); "label" breve en español; "type" uno de: string, number, boolean, array, object; "description" clara para el modelo extractor (que buscar en el PDF/correo); "required" solo true si es critico para el negocio.
- No uses keys reservadas: classification, typeExtraction, model, raw, extraction_input_mode, extractionConfidence, extractionNotes.
- Prioriza campos accionables (fechas, importes, identificadores, nombres, estados) sobre texto libre largo.
- Respondé SOLO JSON con forma exacta: { "fields": [ { "key", "label", "type", "description", "required?" } ] }`;

  const userText = `Tipo documental del cliente:
- key: ${key}
- nombre visible: ${displayName}
${classifierHint ? `- guia ya usada para clasificar documentos: ${classifierHint}` : ""}
${userHint ? `- pedido adicional del usuario: ${userHint}` : ""}
${baseBlock}

Generá el JSON "fields" listo para guardarse en base de datos.${USER_JSON_TAIL}`;

  const response = await client.responses.create({
    model,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userText.slice(0, 12000) }],
      },
    ],
    temperature: 0.35,
    text: { format: { type: "json_object" } },
    store: false,
    max_output_tokens: 3072,
  });

  const raw = extractOutputText(response);
  const parsed = safeJsonParse(raw) || {};
  return normalizeAiExtractionSchema(parsed);
}

/**
 * Clasifica un documento usando el TEXTO OCR ya producido por Azure Document
 * Intelligence (no se sube el PDF a OpenAI). Más barato y consistente con la
 * extracción posterior de campos por OCR.
 *
 * @param {{
 *   ocrText: string,
 *   contextText: string,
 *   allowedTypeKeys: string[],
 *   documentTypes?: Array<{ key: string, displayName: string, hint?: string | null }>,
 * }} input
 * @param {{ model?: string }} [options]
 * @returns {Promise<{ key: string | null, confidence: number, notes: string | null, model: string, rawModelKey?: string }>}
 */
async function classifyDocumentFromOcr(input, options = {}) {
  const model = options.model || env.openaiModel || DEFAULT_MODEL;
  const allowed = Array.isArray(input.allowedTypeKeys)
    ? [...new Set(input.allowedTypeKeys.filter((k) => typeof k === "string" && k.trim()))].map((k) => k.trim())
    : [];

  if (allowed.length === 0) {
    return {
      key: null,
      confidence: 0,
      notes: "Sin tipos documentales habilitados en el workspace",
      model,
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    const key = allowed.includes("other") ? "other" : allowed[0];
    return {
      key,
      confidence: 0.15,
      notes: "OpenAI no configurado; asignación por política mínima",
      model,
    };
  }

  const ocrText = String(input.ocrText || "").trim();
  if (!ocrText) {
    const key = allowed.includes("other") ? "other" : allowed[0];
    return {
      key,
      confidence: 0.1,
      notes: "OCR vacío; asignación por política mínima",
      model,
    };
  }

  const typeLines = buildClassifierTypeLines(input.documentTypes || [], allowed).join("\n");

  const instructions = `Sos un clasificador de DOCUMENTOS adjuntos a correos electrónicos. Vas a recibir el TEXTO OCR del documento (extraído con Azure Document Intelligence) y el contexto del correo. NO ves el PDF original; basate solo en el texto.

El workspace del cliente define los ÚNICOS tipos válidos. Debés elegir exactamente UN tipo.
La salida JSON debe usar el campo "key" IGUAL (mismo texto, sensible a mayúsculas) a una de las keys listadas abajo.

Tipos permitidos:
${typeLines}

Reglas:
- Los tipos pueden ser de cualquier dominio que el cliente haya configurado: facturación, logística, RRHH (CV, contratos), legal, médico, etc.
- Si el documento no encaja claramente en ningún tipo específico, usá la key "other" SOLO si aparece en la lista; si no existe "other", elegí el tipo más cercano y bajá la confianza.
- No inventes keys: "key" debe ser una de: ${allowed.map((k) => `"${k}"`).join(", ")}.

Respondé SOLO con JSON:
{ "key": string, "confidence": number, "notes": string | null }
- confidence entre 0 y 1
- notes breve en español (opcional)`;

  const userText = `=== Texto OCR del documento ===
${ocrText.slice(0, 14000)}

=== Contexto del correo ===
${(input.contextText || "").slice(0, 4000)}${USER_JSON_TAIL}`;

  const response = await client.responses.create({
    model,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    ],
    temperature: 0.15,
    text: { format: { type: "json_object" } },
    store: false,
    max_output_tokens: 400,
  });

  const raw = extractOutputText(response);
  const parsed = safeJsonParse(raw) || {};
  const rawKey = typeof parsed.key === "string" ? parsed.key.trim() : "";
  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.45;
  let notes = parsed.notes != null ? String(parsed.notes).slice(0, 800) : null;

  const { key: normalizedKey, rawModelKey, remapped } = normalizeClassificationKey(rawKey, allowed);
  if (remapped) {
    confidence = Math.min(confidence, 0.55);
    const extra =
      normalizedKey === "other"
        ? ` Modelo sugirió "${rawModelKey || rawKey}"; se usó "other".`
        : normalizedKey
          ? ` Modelo sugirió "${rawModelKey || rawKey}"; se normalizó a "${normalizedKey}".`
          : ` Clave no válida: "${rawModelKey || rawKey}".`;
    notes = `${notes || ""}${extra}`.trim();
  }

  return {
    key: normalizedKey,
    confidence,
    notes,
    model,
    ...(rawModelKey && normalizedKey !== rawModelKey ? { rawModelKey } : {}),
  };
}

/**
 * Extrae campos según schema usando texto OCR + layout. Para cada campo el modelo
 * devuelve además un fragmento textual `evidence` (substring del OCR) que el backend
 * mapea a polígonos en la layout para resaltar en el visor.
 *
 * @param {{
 *   layout: import("./azure-doc-intelligence.service").OcrLayout,
 *   contextText: string,
 *   documentTypeKey: string,
 *   documentTypeLabel: string,
 *   schema: { fields: Array<{ key: string, label: string, type: string, description: string, required: boolean }> },
 * }} input
 * @param {{ model?: string }} [options]
 * @returns {Promise<{
 *   fields: Record<string, { value: unknown, confidence: number | null, spans: Array<{ page: number, polygon: number[], evidenceText: string }>, evidence: string | null }>,
 *   confidence: number,
 *   notes: string | null,
 *   model: string,
 *   raw: string | null,
 * }>}
 */
async function extractFieldsFromOcr(input, options = {}) {
  const model = options.model || env.openaiModel || DEFAULT_MODEL;
  const schema = input.schema && Array.isArray(input.schema.fields) ? input.schema : { fields: [] };
  const { fields } = schema;
  const layout = input.layout;

  if (fields.length === 0) {
    return {
      fields: {},
      confidence: 0,
      notes: "Sin campos definidos en aiExtractionSchema",
      model,
      raw: null,
    };
  }

  const emptyFields = () =>
    Object.fromEntries(fields.map((f) => [f.key, { value: null, confidence: null, spans: [], evidence: null }]));

  if (!layout || !layout.fullText) {
    return {
      fields: emptyFields(),
      confidence: 0,
      notes: "OCR no disponible; no se extraen campos",
      model,
      raw: null,
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    return {
      fields: emptyFields(),
      confidence: 0,
      notes: "OpenAI no configurado",
      model,
      raw: null,
    };
  }

  const typeKey = String(input.documentTypeKey || "documento");
  const typeLabel = String(input.documentTypeLabel || typeKey);
  const fieldLines = buildFieldLinesForPrompt(fields);
  const ocrText = buildPaginatedOcrText(layout, { maxChars: 24000 });

  const instructions = `Sos un extractor de datos de DOCUMENTOS. Recibís el TEXTO OCR (con marcas de página) producido por Azure Document Intelligence; NO ves el PDF.

Tipo documental: "${typeKey}" (${typeLabel}).

Por cada CLAVE del esquema devolvé un objeto:
{
  "value":      string | number | boolean | array | object | null,
  "confidence": number entre 0 y 1,
  "evidence":   string CORTO (máx ~120 chars) copiado LITERALMENTE del texto OCR (preservando mayúsculas/minúsculas) que respalda el valor; null si el dato no aparece
}

Reglas estrictas:
- Tipos: "string" → string|null; "number" → number|null; "boolean" → true|false|null; "array" → array|[]; "object" → object|null.
- "evidence" debe ser un substring EXACTO del texto OCR; si el valor está implícito o se infiere, devolvé null en evidence.
- Si no encontrás el dato, value=null y evidence=null. NO inventes datos.
- Para campos numéricos limpiá separadores: "1.234,56" → 1234.56.

Devolvé SOLO JSON con esta forma:
{
  "extractionConfidence": number,
  "extractionNotes": string | null,
  "fields": { "<clave>": { "value": ..., "confidence": ..., "evidence": ... }, ... }
}

Campos a extraer:
${fieldLines}`;

  const userText = `=== Texto OCR del documento ===
${ocrText}

=== Contexto del correo (asunto y cuerpo) ===
${(input.contextText || "").slice(0, 4000)}${USER_JSON_TAIL}`;

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      ],
      temperature: 0.1,
      text: { format: { type: "json_object" } },
      store: false,
      max_output_tokens: 4096,
    });

    const raw = extractOutputText(response);
    const parsed = safeJsonParse(raw) || {};
    const parsedFields =
      parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)
        ? parsed.fields
        : {};

    let confidence =
      typeof parsed.extractionConfidence === "number" ? parsed.extractionConfidence : 0.45;
    confidence = Math.max(0, Math.min(1, confidence));
    const notes =
      parsed.extractionNotes != null ? String(parsed.extractionNotes).slice(0, 1200) : null;

    const out = {};
    for (const f of fields) {
      const item =
        parsedFields[f.key] && typeof parsedFields[f.key] === "object"
          ? parsedFields[f.key]
          : { value: parsedFields[f.key], confidence: null, evidence: null };

      const value = Object.prototype.hasOwnProperty.call(item, "value") ? item.value : null;
      const fieldConf =
        typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : null;
      const evidence =
        typeof item.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : null;
      const spans = evidence ? findSpansForEvidence(layout, evidence) : [];

      out[f.key] = {
        value: value === undefined ? null : value,
        confidence: fieldConf,
        spans,
        evidence,
      };
    }

    return {
      fields: out,
      confidence,
      notes,
      model,
      raw: raw || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fields: emptyFields(),
      confidence: 0,
      notes: `Error de extracción: ${msg.slice(0, 400)}`,
      model,
      raw: null,
    };
  }
}

module.exports = {
  classifyDocument,
  classifyDocumentFromOcr,
  normalizeAiExtractionSchema,
  extractFieldsBySchema,
  extractFieldsFromOcr,
  suggestAiExtractionSchema,
};
