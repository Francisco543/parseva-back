/**
 * Construye el payload `operations[]` y valida campos obligatorios según `BcField`.
 *
 * @module services/bc-ingest-build
 */

const prisma = require("../lib/prisma");

/**
 * @param {Record<string, unknown>} obj
 * @param {string} path
 * @returns {unknown}
 */
function deepGet(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[p];
  }
  return cur;
}

/**
 * Fusiona extracción OCR con overrides manuales (`bcStagingJson`).
 *
 * @param {{ extractionJson?: unknown; bcStagingJson?: unknown }} doc
 */
function mergeExtractionForBc(doc) {
  const ext =
    doc.extractionJson &&
    typeof doc.extractionJson === "object" &&
    !Array.isArray(doc.extractionJson)
      ? /** @type {Record<string, unknown>} */ (
          JSON.parse(JSON.stringify(doc.extractionJson))
        )
      : {};
  const st =
    doc.bcStagingJson &&
    typeof doc.bcStagingJson === "object" &&
    !Array.isArray(doc.bcStagingJson)
      ? /** @type {Record<string, unknown>} */ (
          JSON.parse(JSON.stringify(doc.bcStagingJson))
        )
      : {};
  return { ...ext, ...st };
}

/**
 * fieldMap: clave/ruta de extracción (notación punto) → campo API BC.
 *
 * @param {unknown} fieldMap
 * @param {Record<string, unknown>} merged
 */
function mapFieldMapToBcFields(fieldMap, merged) {
  const out = {};
  if (!fieldMap || typeof fieldMap !== "object" || Array.isArray(fieldMap)) return out;
  for (const [extractPath, bcKey] of Object.entries(fieldMap)) {
    if (typeof extractPath !== "string" || typeof bcKey !== "string") continue;
    const v = deepGet(merged, extractPath);
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      out[bcKey] = v;
    }
  }
  return out;
}

/**
 * @param {Array<{ fieldMap: unknown; bcTarget: { key: string } }>} profiles
 * @param {Record<string, unknown>} merged
 */
function buildOperationsFromProfiles(profiles, merged) {
  return profiles.map((p) => {
    const fields = mapFieldMapToBcFields(p.fieldMap, merged);
    return {
      targetKey: p.bcTarget.key,
      mode: "upsert",
      matchKeys: {},
      fields,
    };
  });
}

/**
 * @param {string} workspaceId
 * @param {Array<{ id: string; bcTargetId: string; name: string; fieldMap: unknown }>} profiles
 * @param {Record<string, unknown>} merged
 * @returns {Promise<string[]>}
 */
async function listMissingRequiredBcFields(workspaceId, profiles, merged) {
  const missing = [];
  for (const p of profiles) {
    const bcFields = await prisma.bcField.findMany({
      where: { workspaceId, bcTargetId: p.bcTargetId, required: true },
    });
    const fm = p.fieldMap && typeof p.fieldMap === "object" ? p.fieldMap : {};
    for (const bf of bcFields) {
      let extractPath = null;
      for (const [ek, bk] of Object.entries(fm)) {
        if (bk === bf.key && typeof ek === "string") {
          extractPath = ek;
          break;
        }
      }
      if (!extractPath) continue;
      const v = deepGet(merged, extractPath);
      if (v === undefined || v === null || String(v).trim() === "") {
        missing.push(`${p.name}: ${bf.displayName || bf.key} (${extractPath})`);
      }
    }
  }
  return missing;
}

module.exports = {
  deepGet,
  mergeExtractionForBc,
  mapFieldMapToBcFields,
  buildOperationsFromProfiles,
  listMissingRequiredBcFields,
};
