const { normalizeAiExtractionSchema } = require("./document-extraction.service");

/** Fechas (correo / factura según vars) y metadatos del tipo documental */
const SYSTEM_PATH_TOKENS = new Set([
  "year",
  "month",
  "day",
  "received_year",
  "received_month",
  "received_day",
  "doc_type_slug",
  "doc_type",
]);

/**
 * Compatibilidad con plantillas antiguas y flujo factura (invoice-extraction).
 * Preferible definir las mismas keys en el esquema de extracción del tipo.
 */
const LEGACY_INVOICE_PATH_TOKENS = new Set([
  "vendor",
  "vendor_slug",
  "vendor_name",
  "country",
  "area",
  "invoice_number",
]);

function tokenSetFromTemplate(template) {
  const out = new Set();
  if (typeof template !== "string" || !template.trim()) return out;
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(template)) !== null) out.add(m[1]);
  return out;
}

/**
 * @param {string | null | undefined} template
 * @param {unknown} aiExtractionSchema
 * @returns {{ ok: true } | { ok: false, invalidTokens: string[] }}
 */
function validateSharePointPathTemplate(template, aiExtractionSchema) {
  if (template == null || String(template).trim() === "") return { ok: true };
  const t = String(template);
  const schemaNorm = normalizeAiExtractionSchema(aiExtractionSchema);
  const fieldKeys = new Set(schemaNorm.fields.map((f) => f.key).filter(Boolean));
  const invalid = [];
  for (const tok of tokenSetFromTemplate(t)) {
    if (
      SYSTEM_PATH_TOKENS.has(tok) ||
      LEGACY_INVOICE_PATH_TOKENS.has(tok) ||
      fieldKeys.has(tok)
    ) {
      continue;
    }
    invalid.push(tok);
  }
  if (invalid.length) return { ok: false, invalidTokens: invalid };
  return { ok: true };
}

module.exports = {
  SYSTEM_PATH_TOKENS,
  LEGACY_INVOICE_PATH_TOKENS,
  tokenSetFromTemplate,
  validateSharePointPathTemplate,
};
