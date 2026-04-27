const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const env = require("../config/env");
const { logger } = require("../lib/logger");

const DEFAULT_MODEL = "gpt-4o-mini";

/** Límite por archivo en la API OpenAI (documentación: 50 MB; margen seguro) */
const MAX_PDF_BYTES_OPENAI = 45 * 1024 * 1024;

/** Texto por adjunto en modo fallback (pdf-parse); más contexto = menos nulls cuando no hay PDF nativo */
const MAX_CHARS_ATTACHMENT_TEXT = 120000;

/**
 * La API Responses exige que el rol "user" incluya la palabra "json" cuando
 * text.format es json_object (las instructions NO cuentan).
 */
const USER_JSON_FORMAT_TAIL =
  "\n\n---\nSalida obligatoria: un único objeto JSON válido con las claves del esquema indicado en las instrucciones. Sin markdown ni fences; solo el texto json.";

const DOC_TYPES = new Set([
  "invoice",
  "credit_note",
  "debit_note",
  "proforma",
  "receipt",
  "other",
]);

const EXTRACTION_PROMPT = `Eres un extractor experto de datos tributarios y comerciales para un SaaS B2B de cuentas por pagar (Europa, LATAM, EE.UU.).

Cuando recibes un PDF de factura como archivo, analiza el documento completo (texto y disposición visual: logos, tablas, sellos, totales al pie). El PDF tiene prioridad absoluta frente al asunto o cuerpo del correo.

Si solo hay texto del correo u otros adjuntos sin PDF nativo, usa ese contenido y marca menor confianza si falta el comprobante.

Devuelve SOLO un JSON válido con estas claves (null si no consta en el documento):

{
  "vendor_name": string | null,
  "vendor_tax_id": string | null,
  "invoice_number": string | null,
  "invoice_date": string | null,
  "invoice_date_raw": string | null,
  "due_date": string | null,
  "currency": string | null,
  "total_amount": number | null,
  "subtotal": number | null,
  "tax_amount": number | null,
  "country": string | null,
  "area": string | null,
  "document_type": string | null,
  "purchase_order": string | null,
  "confidence": number,
  "notes": string | null
}

Reglas estrictas:
- vendor_name: razón social o nombre comercial del EMISOR / PROVEEDOR (no el del cliente receptor). Si hay varios nombres, el del emisor fiscal.
- vendor_tax_id: CUIT/CUIL, RFC, NIF/CIF, VAT, EIN, etc.; sin texto adicional.
- invoice_number: número de factura o comprobante tal como en el documento.
- invoice_date: fecha de EMISIÓN de la factura en formato ISO 8601 fecha únicamente: YYYY-MM-DD. No uses la fecha del correo salvo que la factura no muestre ninguna fecha.
- invoice_date_raw: texto tal como aparece en la factura para esa fecha (ej. "15/03/2024"), o null.
- due_date: vencimiento de pago en YYYY-MM-DD si existe.
- currency: código ISO 4217 de tres letras (EUR, USD, ARS, MXN, GBP, …). Si solo hay símbolo, infiere el código razonablemente.
- total_amount: importe TOTAL a pagar (número decimal con punto). Si hay varios totales, el total final con impuestos.
- subtotal y tax_amount: base imponible e impuestos si constan; si no, null.
- country: país del emisor inferido del ID fiscal, dirección o moneda.
- area: rubro, categoría o descripción corta del gasto si aparece; si no, null.
- document_type: uno de: invoice, credit_note, debit_note, proforma, receipt, other.
- purchase_order: número de pedido / OC / PO si aparece.
- confidence: entre 0 y 1 (tu certeza global en la extracción basada en claridad del PDF).
- notes: incertidumbres, campos ambiguos o hipótesis (breve); null si todo es claro.

CRÍTICO — no devuelvas campos clave en null por precaución:
- Si ves CUALQUIER importe de total o “Total a pagar / Importe / Amount due”, extrá total_amount (número) aunque el formato sea 1.234,56 o 1,234.56.
- Si ves moneda (€, EUR, $, USD, MXN, etc.), rellena currency en ISO 4217.
- Si ves una fecha de emisión aunque esté como 12/03/2025 o “12 marzo 2025”, pon invoice_date_raw con el texto exacto y invoice_date en YYYY-MM-DD si puedes inferirlo sin ambigüedad grave (DD/MM para España/LATAM salvo evidencia US).
- Solo usa null si ese dato realmente no aparece en el documento ni en el contexto.

Si el texto extraído es escaso pero ves datos en el PDF como imagen, dedúcelos del layout; baja confidence y explica en notes.`;

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.45;
  return Math.min(1, Math.max(0, n));
}

function parseNumberFlexible(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    let s = v.replace(/\s/g, "");
    const neg = s.startsWith("-");
    if (neg) s = s.slice(1);
    s = s.replace(/[^\d.,]/g, "");
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    let normalized = s;
    if (lastComma > lastDot) normalized = s.replace(/\./g, "").replace(",", ".");
    else if (lastComma !== -1 || lastDot !== -1) normalized = s.replace(/,/g, "");
    const n = Number(normalized);
    if (Number.isNaN(n)) return null;
    return neg ? -n : n;
  }
  return null;
}

function toIsoDateOnlyUtc(d) {
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseFlexibleDateToIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : toIsoDateOnlyUtc(d);
  }
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const day = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, day));
    if (!Number.isNaN(dt.getTime())) return `${m[1]}-${m[2]}-${m[3]}`;
  }

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const dt = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(dt.getTime()))
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const dt = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(dt.getTime()))
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return toIsoDateOnlyUtc(d);
  return null;
}

function normalizeCurrency(c) {
  if (c == null || c === "") return null;
  if (typeof c !== "string") return null;
  const t = c.trim();
  const compact = t.replace(/\s+/g, "").toUpperCase();
  if (/^[A-Z]{3}$/.test(compact)) return compact;

  const map = new Map([
    ["$", "USD"],
    ["€", "EUR"],
    ["£", "GBP"],
    ["EURO", "EUR"],
    ["EUROS", "EUR"],
    ["DOLAR", "USD"],
    ["DOLARES", "USD"],
    ["DÓLAR", "USD"],
    ["DÓLARES", "USD"],
    ["US$", "USD"],
    ["U$S", "USD"],
    ["AR$", "ARS"],
    ["LIBRA", "GBP"],
    ["POUNDS", "GBP"],
  ]);
  if (map.has(t)) return map.get(t);
  if (map.has(compact)) return map.get(compact);

  const upper = t.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper.replace(/\s/g, ""))) return upper.replace(/\s/g, "").slice(0, 3);

  return upper.length <= 3 ? upper : null;
}

function normalizeTaxId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s.\-]/g, "").toUpperCase();
  return cleaned.length ? cleaned.slice(0, 32) : null;
}

function normalizeVendorName(name) {
  if (!name || typeof name !== "string") return null;
  const t = name.replace(/\s+/g, " ").trim();
  if (!t || /^(unknown|desconocido|n\/a|sin nombre)$/i.test(t)) return null;
  return t.slice(0, 300);
}

/**
 * Normaliza y valida el JSON devuelto por el modelo (o fallback).
 * @param {Record<string, unknown>} parsed
 * @returns {Record<string, unknown>}
 */
function normalizeParsedExtraction(parsed) {
  const p = parsed && typeof parsed === "object" ? { ...parsed } : {};
  const invoice_date_raw =
    p.invoice_date_raw != null ? String(p.invoice_date_raw).trim().slice(0, 120) || null : null;

  let invoice_date =
    parseFlexibleDateToIso(p.invoice_date) || parseFlexibleDateToIso(invoice_date_raw);
  const due_date = parseFlexibleDateToIso(p.due_date);

  let document_type =
    typeof p.document_type === "string" ? p.document_type.toLowerCase().trim() : "invoice";
  if (!DOC_TYPES.has(document_type)) document_type = "invoice";

  let confidence = clamp01(
    typeof p.confidence === "number" ? p.confidence : Number(p.confidence)
  );
  if (Number.isNaN(confidence)) confidence = 0.45;

  return {
    vendor_name: normalizeVendorName(p.vendor_name),
    vendor_tax_id: normalizeTaxId(p.vendor_tax_id),
    invoice_number:
      p.invoice_number != null
        ? String(p.invoice_number).trim().slice(0, 80) || null
        : null,
    invoice_date,
    invoice_date_raw,
    due_date,
    currency: normalizeCurrency(p.currency),
    total_amount: parseNumberFlexible(p.total_amount),
    subtotal: parseNumberFlexible(p.subtotal),
    tax_amount: parseNumberFlexible(p.tax_amount),
    country:
      p.country != null ? String(p.country).trim().slice(0, 80) || null : null,
    area: p.area != null ? String(p.area).trim().slice(0, 120) || null : null,
    document_type,
    purchase_order:
      p.purchase_order != null
        ? String(p.purchase_order).trim().slice(0, 80) || null
        : null,
    confidence,
    notes: p.notes != null ? String(p.notes).trim().slice(0, 2000) || null : null,
  };
}

/**
 * Convierte YYYY-MM-DD a Date UTC medianoche (consistente con Prisma).
 * @param {string | null | undefined} isoDateStr
 * @returns {Date | null}
 */
function isoStringToUtcDate(isoDateStr) {
  if (!isoDateStr || typeof isoDateStr !== "string") return null;
  const m = isoDateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, day));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getOpenAIClient() {
  if (!env.openaiApiKey) return null;
  return new OpenAI({ apiKey: env.openaiApiKey });
}

function safePdfFilename(name) {
  const base = String(name || "factura.pdf").replace(/["*:<>?/\\|]/g, "_");
  const trimmed = base.slice(0, 120);
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed || "factura"}.pdf`;
}

/** Contexto completo (incl. texto de pdf-parse del PDF principal) para ramas solo texto */
function textBranchInput(input) {
  if (input.attachmentTextsFallback?.length) {
    return { ...input, attachmentTexts: input.attachmentTextsFallback };
  }
  return input;
}

function buildEmailContextText(input) {
  const parts = [
    "=== Contexto del correo (secundario si hay PDF de factura adjunto en este mensaje) ===",
    `Asunto: ${input.subject}`,
    `Cuerpo:\n${(input.bodyText || "").slice(0, 12000)}`,
  ];
  if (input.attachmentTexts?.length) {
    for (const a of input.attachmentTexts) {
      parts.push(
        `\n--- Adjunto: ${a.name} ---\n${(a.text || "").slice(0, MAX_CHARS_ATTACHMENT_TEXT)}`
      );
    }
  }
  return parts.join("\n") + USER_JSON_FORMAT_TAIL;
}

/** Por si el SDK no rellena output_text o viene vacío */
function extractOutputTextFromResponse(response) {
  const direct = response?.output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const chunks = [];
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
      }
    }
  }
  return chunks.join("").trim();
}

function stripJsonFences(text) {
  let t = String(text || "").trim();
  if (!t) return t;
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(t);
  if (fence) return fence[1].trim();
  return t;
}

function parseResponseJson(raw, input) {
  let text = stripJsonFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return normalizeParsedExtraction(fallbackExtraction(input));
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return normalizeParsedExtraction(fallbackExtraction(input));
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return normalizeParsedExtraction(fallbackExtraction(input));
  }
  return normalizeParsedExtraction(parsed);
}

/**
 * Extracción vía Responses API (PDF + texto o solo texto).
 */
async function runResponsesExtract(client, model, userContent, input) {
  const response = await client.responses.create({
    model,
    instructions: EXTRACTION_PROMPT,
    input: [
      {
        role: "user",
        content: userContent,
      },
    ],
    temperature: 0.1,
    text: { format: { type: "json_object" } },
    store: false,
    max_output_tokens: 4096,
  });
  const raw = extractOutputTextFromResponse(response) || "{}";
  return { raw, parsed: parseResponseJson(raw, input), model };
}

/**
 * PDF vía Responses: primero subida a Files API (cuerpo más pequeño, suele evitar timeouts),
 * si falla reintenta con base64 inline.
 */
async function extractWithPdfNative(client, pdfModel, input, pdf) {
  const filename = safePdfFilename(pdf.name);
  let uploadedId = null;
  try {
    try {
      const created = await client.files.create({
        file: await toFile(pdf.buffer, filename),
        purpose: "user_data",
      });
      uploadedId = created.id;
      const out = await runResponsesExtract(client, pdfModel, [
        { type: "input_file", file_id: uploadedId },
        { type: "input_text", text: buildEmailContextText(input) },
      ], input);
      return { ...out, inputMode: "pdf_native_file_id" };
    } catch (e1) {
      const msg = e1 instanceof Error ? e1.message : String(e1);
      logger.warn(
        { component: "invoice-extraction", err: msg },
        "PDF por file_id falló, reintento base64"
      );
      const out = await runResponsesExtract(client, pdfModel, [
        {
          type: "input_file",
          filename,
          file_data: `data:application/pdf;base64,${pdf.buffer.toString("base64")}`,
        },
        { type: "input_text", text: buildEmailContextText(input) },
      ], input);
      return { ...out, inputMode: "pdf_native_base64" };
    }
  } finally {
    if (uploadedId) {
      try {
        await client.files.delete(uploadedId);
      } catch {
        /* ignore */
      }
    }
  }
}

async function extractWithChatCompletionsFallback(client, model, input) {
  const body = buildEmailContextText(input);
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: body },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  return { raw, parsed: parseResponseJson(raw, input), model };
}

/**
 * @param {{ subject: string, bodyText: string, attachmentTexts?: { name: string, text: string }[], primaryPdf?: { buffer: Buffer, name: string, contentType?: string } | null }} input
 * @param {{ model?: string }} [options]
 */
async function extractInvoiceFromText(input, options = {}) {
  const client = getOpenAIClient();
  const textModel = options.model || env.openaiModel || DEFAULT_MODEL;
  const pdfModel = env.openaiPdfModel || textModel;

  if (!client) {
    return {
      raw: null,
      parsed: normalizeParsedExtraction(fallbackExtraction(input)),
      model: "stub",
      inputMode: "stub",
    };
  }

  const pdf = input.primaryPdf;
  const useNativePdf =
    env.openaiNativePdfEnabled &&
    pdf?.buffer &&
    Buffer.isBuffer(pdf.buffer) &&
    pdf.buffer.length > 0;

  const inputForText = textBranchInput(input);

  if (useNativePdf && pdf.buffer.length <= MAX_PDF_BYTES_OPENAI) {
    try {
      const out = await extractWithPdfNative(client, pdfModel, input, pdf);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { component: "invoice-extraction", err: msg },
        "PDF nativo (file_id + base64) falló; pasando a solo texto"
      );
    }
  } else if (useNativePdf && pdf.buffer.length > MAX_PDF_BYTES_OPENAI) {
    logger.warn(
      { component: "invoice-extraction", bytes: pdf.buffer.length, limit: MAX_PDF_BYTES_OPENAI },
      "PDF demasiado grande para OpenAI; usando solo texto"
    );
  }

  try {
    const userContent = [
      { type: "input_text", text: buildEmailContextText(inputForText) },
    ];
    const out = await runResponsesExtract(client, textModel, userContent, inputForText);
    return { ...out, inputMode: "text_responses" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { component: "invoice-extraction", err: msg },
      "Responses API falló, fallback Chat Completions"
    );
    const out = await extractWithChatCompletionsFallback(client, textModel, inputForText);
    return { ...out, inputMode: "text_chat_fallback" };
  }
}

function fallbackExtraction(input) {
  const subject = input.subject || "";
  const totalMatch = subject.match(/(\d+[.,]\d{2})\s*(USD|EUR|ARS|\$|€)/i);
  const numberMatch = subject.match(
    /(?:n[°º]|#|invoice|factura)\s*[:#]?\s*([A-Z0-9\-]+)/i
  );

  return {
    vendor_name: null,
    vendor_tax_id: null,
    invoice_number: numberMatch ? numberMatch[1] : null,
    invoice_date: null,
    invoice_date_raw: null,
    due_date: null,
    currency: totalMatch ? totalMatch[2].replace("$", "USD") : null,
    total_amount: totalMatch ? Number(totalMatch[1].replace(",", ".")) : null,
    subtotal: null,
    tax_amount: null,
    country: null,
    area: null,
    document_type: "invoice",
    purchase_order: null,
    confidence: 0.22,
    notes: "Extracción básica sin modelo; revisar documento.",
  };
}

module.exports = {
  extractInvoiceFromText,
  normalizeParsedExtraction,
  isoStringToUtcDate,
  getOpenAIClient,
};
