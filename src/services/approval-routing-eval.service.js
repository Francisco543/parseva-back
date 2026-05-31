/**
 * Evaluación segura de `conditionJson` para reglas de enrutado de aprobación.
 * Sin eval ni código arbitrario: solo operadores declarados.
 *
 * @module services/approval-routing-eval
 */

const { normalizeAiExtractionSchema } = require("./document-extraction.service");

/** Campos típicos del flujo factura legacy (sin esquema AI en el tipo). */
const INVOICE_FLAT_FIELD_KEYS = new Set([
  "vendor_name",
  "vendor_tax_id",
  "invoice_number",
  "invoice_date",
  "invoice_date_raw",
  "due_date",
  "currency",
  "total_amount",
  "subtotal",
  "tax_amount",
  "country",
  "area",
  "document_type",
  "purchase_order",
  "confidence",
  "notes",
]);

const META_CONFIDENCE = "__confidence";

/**
 * @param {unknown} aiExtractionSchema
 * @returns {Set<string>}
 */
function buildAllowedRuleFieldKeys(aiExtractionSchema) {
  const norm = normalizeAiExtractionSchema(aiExtractionSchema);
  const set = new Set();
  for (const f of norm.fields) {
    if (f.key) set.add(f.key);
  }
  if (set.size === 0) {
    for (const k of INVOICE_FLAT_FIELD_KEYS) set.add(k);
  }
  set.add(META_CONFIDENCE);
  return set;
}

/**
 * @param {unknown} extractionJson
 * @param {string} field
 * @param {number | null | undefined} documentConfidence
 * @returns {unknown}
 */
function readExtractionField(extractionJson, field, documentConfidence) {
  if (field === META_CONFIDENCE) {
    return documentConfidence != null && typeof documentConfidence === "number"
      ? documentConfidence
      : null;
  }
  const ex = extractionJson && typeof extractionJson === "object" && !Array.isArray(extractionJson)
    ? extractionJson
    : {};
  const fields = ex.fields && typeof ex.fields === "object" ? ex.fields : null;
  if (fields && Object.prototype.hasOwnProperty.call(fields, field)) {
    const cell = fields[field];
    if (cell && typeof cell === "object" && Object.prototype.hasOwnProperty.call(cell, "value")) {
      return cell.value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(ex, field)) return ex[field];
  return undefined;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim().replace(/\s/g, "").replace(",", ".");
    if (t === "") return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {unknown} conditionJson
 * @param {unknown} extractionJson
 * @param {number | null | undefined} documentConfidence
 * @param {Set<string>} allowedFields
 * @returns {boolean}
 */
function matchesCondition(conditionJson, extractionJson, documentConfidence, allowedFields) {
  const c =
    conditionJson && typeof conditionJson === "object" && !Array.isArray(conditionJson)
      ? conditionJson
      : {};
  const op = typeof c.op === "string" ? c.op.trim().toLowerCase() : "";
  if (op === "always") return true;

  const field = typeof c.field === "string" ? c.field.trim() : "";
  if (!field || !allowedFields.has(field)) return false;

  const actual = readExtractionField(extractionJson, field, documentConfidence);

  if (op === "eq") {
    const expected = c.value;
    if (actual === null || actual === undefined) return false;
    if (typeof actual === "number" || typeof expected === "number") {
      const na = toNumber(actual);
      const ne = toNumber(expected);
      if (na === null || ne === null) return false;
      return na === ne;
    }
    return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
  }

  if (op === "in") {
    const values = Array.isArray(c.values) ? c.values : [];
    if (values.length === 0 || actual === null || actual === undefined) return false;
    const av =
      typeof actual === "number"
        ? String(actual)
        : String(actual)
            .trim()
            .toLowerCase();
    return values.some((v) => {
      if (typeof actual === "number" || typeof v === "number") {
        const na = toNumber(actual);
        const nv = toNumber(v);
        return na !== null && nv !== null && na === nv;
      }
      return av === String(v).trim().toLowerCase();
    });
  }

  if (op === "contains_ci") {
    const needle = c.value != null ? String(c.value).trim().toLowerCase() : "";
    if (!needle || actual === null || actual === undefined) return false;
    return String(actual).toLowerCase().includes(needle);
  }

  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const boundary = toNumber(c.value);
    const na = toNumber(actual);
    if (boundary === null || na === null) return false;
    if (op === "gt") return na > boundary;
    if (op === "gte") return na >= boundary;
    if (op === "lt") return na < boundary;
    return na <= boundary;
  }

  return false;
}

/**
 * @param {Array<{ id: string, conditionJson: unknown, assigneeUserId: string }>} rules
 * @param {unknown} extractionJson
 * @param {number | null | undefined} documentConfidence
 * @param {Set<string>} allowedFields
 * @returns {{ ruleId: string, assigneeUserId: string } | null}
 */
function findFirstMatchingRule(rules, extractionJson, documentConfidence, allowedFields) {
  for (const r of rules) {
    if (!r || !r.assigneeUserId) continue;
    if (matchesCondition(r.conditionJson, extractionJson, documentConfidence, allowedFields)) {
      return { ruleId: r.id, assigneeUserId: r.assigneeUserId };
    }
  }
  return null;
}

module.exports = {
  buildAllowedRuleFieldKeys,
  META_CONFIDENCE,
  matchesCondition,
  findFirstMatchingRule,
  readExtractionField,
};
