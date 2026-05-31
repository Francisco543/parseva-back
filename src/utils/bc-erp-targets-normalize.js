/**
 * Normaliza la respuesta OData GET …/targets de la extensión parseva-api-bc.
 *
 * @param {unknown} json
 * @returns {{
 *   targets: Array<{
 *     targetKey: string;
 *     displayName: string;
 *     category: string | null;
 *     fields: unknown[];
 *     relations?: unknown;
 *     schemaVersion?: unknown;
 *     entityHint?: unknown;
 *   }>;
 * }}
 */

/**
 * OData / BC pueden nombrar el campo Blob de forma distinta (fieldsDefinition, Fields_Definition…).
 * Cabecera larga partida en columnas Text[2048]: fieldsDefinition + fieldsDefinitionPart2 + fieldsDefinitionPart3.
 *
 * @param {unknown} row
 * @returns {unknown}
 */
function pickFieldsDefinitionRaw(row) {
  if (!row || typeof row !== "object") return undefined;
  const r = /** @type {Record<string, unknown>} */ (row);
  const part2 =
    typeof r.fieldsDefinitionPart2 === "string"
      ? r.fieldsDefinitionPart2
      : typeof r.Fields_Definition_Text_2 === "string"
        ? r.Fields_Definition_Text_2
        : "";

  const part3 =
    typeof r.fieldsDefinitionPart3 === "string"
      ? r.fieldsDefinitionPart3
      : typeof r.Fields_Definition_Text_3 === "string"
        ? r.Fields_Definition_Text_3
        : "";

  const direct =
    r.fieldsDefinition ??
    r.Fields_Definition ??
    r.FieldsDefinition ??
    r.fields_definition;

  if (direct !== undefined && direct !== null) {
    const base = typeof direct === "string" ? direct : "";
    const tail = (part2 || "") + (part3 || "");
    if (tail) return base + tail;
    return direct;
  }

  const keys = Object.keys(r);
  for (const k of keys) {
    const norm = k.replace(/_/g, "").toLowerCase();
    if (norm === "fieldsdefinition" || norm.endsWith("fieldsdefinition")) {
      const v = r[k];
      const base = typeof v === "string" ? v : "";
      const tail = (part2 || "") + (part3 || "");
      return tail ? base + tail : v;
    }
  }
  return undefined;
}

/**
 * @param {unknown} fd
 * @returns {{
 *   fields: unknown[];
 *   relations: unknown;
 *   schemaVersion: unknown;
 *   entityHint: unknown;
 * }}
 */
function parseFieldsDefinitionPayload(fd) {
  const empty = {
    fields: [],
    relations: null,
    schemaVersion: null,
    entityHint: null,
  };
  if (fd == null) return empty;
  if (typeof fd === "object" && fd !== null && !Array.isArray(fd) && "fields" in fd) {
    const o = /** @type {Record<string, unknown>} */ (fd);
    return {
      fields: Array.isArray(o.fields) ? o.fields : [],
      relations: o.relations ?? o.relation ?? null,
      schemaVersion: o.schemaVersion ?? null,
      entityHint: o.entityHint ?? null,
    };
  }
  if (typeof fd !== "string") return empty;
  const s = fd.trim();
  if (!s) return empty;

  /** @type {unknown} */
  let parsed;
  try {
    const decoded = Buffer.from(s, "base64").toString("utf8");
    parsed = JSON.parse(decoded);
  } catch {
    try {
      parsed = JSON.parse(s);
    } catch {
      return empty;
    }
  }

  if (!parsed || typeof parsed !== "object") return empty;
  const o = /** @type {Record<string, unknown>} */ (parsed);
  return {
    fields: Array.isArray(o.fields) ? o.fields : [],
    relations: o.relations ?? o.relation ?? null,
    schemaVersion: o.schemaVersion ?? null,
    entityHint: o.entityHint ?? null,
  };
}

function normalizeBcTargetsPayload(json) {
  if (json && typeof json === "object" && Array.isArray(/** @type {{ targets?: unknown }} */ (json).targets)) {
    return /** @type {{ targets: unknown[] }} */ (json);
  }
  const value = json && typeof json === "object" ? /** @type {{ value?: unknown }} */ (json).value : undefined;
  if (!Array.isArray(value)) return { targets: [] };
  return {
    targets: value.map((row) => {
      const fd = pickFieldsDefinitionRaw(row);
      const meta = parseFieldsDefinitionPayload(fd);
      const r = row && typeof row === "object" ? row : {};
      return {
        targetKey: String(/** @type {{ targetKey?: unknown }} */ (r).targetKey ?? ""),
        displayName: String(/** @type {{ displayName?: unknown }} */ (r).displayName ?? ""),
        category:
          /** @type {{ category?: unknown }} */ (r).category != null
            ? String(/** @type {{ category?: unknown }} */ (r).category)
            : null,
        fields: meta.fields,
        ...(meta.relations != null ? { relations: meta.relations } : {}),
        ...(meta.schemaVersion != null ? { schemaVersion: meta.schemaVersion } : {}),
        ...(meta.entityHint != null ? { entityHint: meta.entityHint } : {}),
      };
    }),
  };
}

module.exports = {
  normalizeBcTargetsPayload,
};
