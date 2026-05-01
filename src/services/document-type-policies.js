const { z } = require("zod");

const sharepointRoutingSchema = z
  .object({
    rootFolder: z.string().max(255).optional().nullable(),
    pathTemplate: z.string().max(500).optional().nullable(),
    description: z.string().max(500).optional().nullable(),
  })
  .strict()
  .optional()
  .nullable();

const semanticMatchPolicySchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    semanticWeight: z.number().min(0).max(1).optional().default(0.3),
    semanticMinSimilarity: z.number().min(0).max(1).optional().default(0.72),
    neighborLimit: z.number().int().min(5).max(200).optional().default(30),
  })
  .strict()
  .optional()
  .nullable();

/**
 * Regla de matching por campo: aplica al evaluar un candidato cuyo tipo coincide
 * con `targetTypeKey`. Si `sourceField` y `targetField` coinciden según
 * `comparator`, suma 1 al score estructural (saturando a 1).
 */
const fieldJoinRuleSchema = z.object({
  targetTypeKey: z.string().min(1).max(80),
  sourceField: z.string().min(1).max(120),
  targetField: z.string().min(1).max(120),
  comparator: z.enum(["exact", "ci", "number_close"]).optional().default("exact"),
});

const matchingPolicySchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    /** Tipos documentales candidatos (keys) contra los que correlacionar, ej remito desde factura */
    /** Como máximo un tipo destino por ahora (matching 1:1 a nivel de tabla). */
    relatedDocumentTypeKeys: z.array(z.string().min(1).max(80)).max(1).optional().default([]),
    /** Cardinalidad esperada del vínculo entre documentos */
    relationCardinality: z
      .enum(["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"])
      .optional()
      .default("MANY_TO_MANY"),
    autoMatchAfterIngest: z.boolean().optional().default(false),
    minLinkScore: z.number().min(0).max(1).optional().default(0.35),
    /**
     * Reglas explícitas para correlacionar documentos por igualdad de campos
     * extraídos. Si no hay reglas, se usa la heurística por defecto.
     */
    fieldJoinRules: z.array(fieldJoinRuleSchema).max(10).optional().default([]),
    semanticMatch: semanticMatchPolicySchema,
  })
  .strict()
  .optional()
  .nullable();

const approvalPolicySchema = z
  .object({
    /** Si la confianza IA (clasificación o extracción) está por debajo, requiere revisión humana */
    minConfidenceForAutoPass: z.number().min(0).max(1).optional().default(0.8),
    requireHumanBelowThreshold: z.boolean().optional().default(true),
  })
  .strict()
  .optional()
  .nullable();

const validationPolicySchema = z
  .object({
    /** Rutas dentro de extractionJson que deben existir y ser no vacías (ej: vendor_tax_id) */
    requiredExtractionPaths: z.array(z.string().min(1).max(120)).max(40).optional().default([]),
  })
  .strict()
  .optional()
  .nullable();

const bcPolicySchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    mappingProfileId: z.string().optional().nullable(),
    /** MANUAL: solo vía API/botón | AFTER_APPROVAL: al aprobar | AUTO_IF_CONFIDENT: si pasa validación + umbral */
    syncMode: z.enum(["MANUAL", "AFTER_APPROVAL", "AUTO_IF_CONFIDENT"]).optional().default("MANUAL"),
    autoMinConfidence: z.number().min(0).max(1).optional().default(0.85),
  })
  .strict()
  .optional()
  .nullable();

const policiesPatchSchema = z.object({
  sharepointRouting: sharepointRoutingSchema,
  matchingPolicy: matchingPolicySchema,
  approvalPolicy: approvalPolicySchema,
  validationPolicy: validationPolicySchema,
  bcPolicy: bcPolicySchema,
  configVersion: z.number().int().min(1).optional(),
});

function normalizePolicies(row) {
  const ap = row?.approvalPolicy && typeof row.approvalPolicy === "object" ? row.approvalPolicy : {};
  const mp = row?.matchingPolicy && typeof row.matchingPolicy === "object" ? row.matchingPolicy : {};
  const sm = mp.semanticMatch && typeof mp.semanticMatch === "object" ? mp.semanticMatch : {};
  const vp = row?.validationPolicy && typeof row.validationPolicy === "object" ? row.validationPolicy : {};
  const bp = row?.bcPolicy && typeof row.bcPolicy === "object" ? row.bcPolicy : {};
  const sp = row?.sharepointRouting && typeof row.sharepointRouting === "object" ? row.sharepointRouting : {};
  return {
    sharepointRouting: {
      rootFolder: sp.rootFolder ?? null,
      pathTemplate: sp.pathTemplate ?? null,
      description: sp.description ?? null,
    },
    matchingPolicy: {
      enabled: mp.enabled !== false,
      relatedDocumentTypeKeys: Array.isArray(mp.relatedDocumentTypeKeys)
        ? mp.relatedDocumentTypeKeys
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, 1)
        : [],
      relationCardinality: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"].includes(
        mp.relationCardinality
      )
        ? mp.relationCardinality
        : "MANY_TO_MANY",
      autoMatchAfterIngest: mp.autoMatchAfterIngest === true,
      minLinkScore: typeof mp.minLinkScore === "number" ? mp.minLinkScore : 0.35,
      fieldJoinRules: Array.isArray(mp.fieldJoinRules)
        ? mp.fieldJoinRules
            .filter((r) => r && typeof r === "object")
            .map((r) => ({
              targetTypeKey: String(r.targetTypeKey || "").trim(),
              sourceField: String(r.sourceField || "").trim(),
              targetField: String(r.targetField || "").trim(),
              comparator: ["exact", "ci", "number_close"].includes(r.comparator)
                ? r.comparator
                : "exact",
            }))
            .filter((r) => r.targetTypeKey && r.sourceField && r.targetField)
        : [],
      semanticMatch: {
        enabled: sm.enabled === true,
        semanticWeight:
          typeof sm.semanticWeight === "number" && sm.semanticWeight >= 0 && sm.semanticWeight <= 1
            ? sm.semanticWeight
            : 0.3,
        semanticMinSimilarity:
          typeof sm.semanticMinSimilarity === "number" &&
          sm.semanticMinSimilarity >= 0 &&
          sm.semanticMinSimilarity <= 1
            ? sm.semanticMinSimilarity
            : 0.72,
        neighborLimit:
          typeof sm.neighborLimit === "number" && sm.neighborLimit >= 5 && sm.neighborLimit <= 200
            ? Math.floor(sm.neighborLimit)
            : 30,
      },
    },
    approvalPolicy: {
      minConfidenceForAutoPass:
        typeof ap.minConfidenceForAutoPass === "number" ? ap.minConfidenceForAutoPass : 0.8,
      requireHumanBelowThreshold: ap.requireHumanBelowThreshold !== false,
    },
    validationPolicy: {
      requiredExtractionPaths: Array.isArray(vp.requiredExtractionPaths) ? vp.requiredExtractionPaths : [],
    },
    bcPolicy: {
      enabled: bp.enabled === true,
      mappingProfileId: bp.mappingProfileId || null,
      syncMode: ["MANUAL", "AFTER_APPROVAL", "AUTO_IF_CONFIDENT"].includes(bp.syncMode)
        ? bp.syncMode
        : "MANUAL",
      autoMinConfidence: typeof bp.autoMinConfidence === "number" ? bp.autoMinConfidence : 0.85,
    },
  };
}

function getPath(obj, dotted) {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function validationErrorsForDocument(extractionJson, validationPolicy) {
  const pol = normalizePolicies({ validationPolicy }).validationPolicy;
  const errors = [];
  for (const path of pol.requiredExtractionPaths) {
    const v = getPath(extractionJson, path);
    if (v === undefined || v === null || v === "") {
      errors.push(`Missing or empty: ${path}`);
    }
  }
  return errors;
}

function confidenceForDocument(doc, extractionParsed) {
  const ex = doc?.extractionJson;
  const cls = ex?.classification?.confidence;
  const typeExt = ex?.typeExtraction?.confidence;
  const ext = extractionParsed?.confidence;
  const nums = [
    typeof cls === "number" ? cls : null,
    typeof typeExt === "number" ? typeExt : null,
    typeof ext === "number" ? ext : null,
  ].filter((n) => n != null);
  if (!nums.length) return null;
  return Math.min(...nums);
}

module.exports = {
  policiesPatchSchema,
  normalizePolicies,
  validationErrorsForDocument,
  confidenceForDocument,
};
