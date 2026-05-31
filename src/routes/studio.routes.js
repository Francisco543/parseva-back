/**
 * @file Endpoints del "Studio": configuración avanzada de matching entre
 * documentos, perfiles de mapeo de Business Central, targets/fields y
 * disparo manual de sincronización.
 *
 * Está pensado para usuarios con permisos elevados en el workspace.
 *
 * @module routes/studio
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const { createAuditEvent } = require("../services/audit.service");
const {
  listMatchRules,
  upsertMatchRule,
  listDocumentLinks,
  upsertDocumentLink,
  runAutoMatchForDocument,
} = require("../services/document-matching.service");
const {
  listBcTargets,
  upsertBcTarget,
  upsertBcField,
  listMappingProfiles,
  upsertMappingProfile,
  upsertExtensionTarget,
  importErpTargetIntoWorkspace,
} = require("../services/bc-mapping-studio.service");
const { normalizeBcTargetsPayload } = require("../utils/bc-erp-targets-normalize");
const { extractBcApiErrorMessage } = require("../utils/bc-erp-api-error-message");
const {
  queueBcSync,
  processPendingBcSync,
  listBcSyncEvents,
} = require("../services/bc-sync.service");
const { bcErpFetch, listBcODataCompanies, listBcEnvironments } = require("../services/bc-erp-client.service");
const { buildBcIngestPreview } = require("../services/bc-ingest-preview.service");
const { suggestBcFieldMapping } = require("../services/bc-mapping-suggest.service");
const HttpError = require("../utils/http-error");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

/**
 * Rutas OData de la extensión `parseva-api-bc` (entity sets).
 *
 * @param {string} lookupRef
 * @param {string} q
 * @param {string} top
 */
function buildErpLookupPath(lookupRef, q, top) {
  const ref = String(lookupRef).toLowerCase();
  const t = Math.min(100, Math.max(1, parseInt(String(top), 10) || 20));
  if (ref === "vendors") {
    const esc = String(q).replace(/'/g, "''");
    const filter = esc ? `$filter=contains(no,'${esc}') or contains(displayName,'${esc}')` : "";
    const qs = [filter, `$top=${t}`].filter(Boolean).join("&");
    return `/lookupVendors?${qs}`;
  }
  return `/lookups/${encodeURIComponent(lookupRef)}?q=${encodeURIComponent(String(q))}&top=${encodeURIComponent(String(t))}`;
}

/** Adapta catálogo OData → `{ items }` para el searchbox del front. */
function normalizeBcLookupItems(lookupRef, json) {
  const ref = String(lookupRef).toLowerCase();
  if (ref === "vendors" && Array.isArray(json.value)) {
    return {
      items: json.value.map((v) => ({
        id: String(v.no ?? ""),
        display: String(v.displayName ?? v.no ?? ""),
        subtitle: v.city ? String(v.city) : null,
        raw: v,
      })),
    };
  }
  if (Array.isArray(json.items)) return json;
  if (Array.isArray(json.value)) {
    return {
      items: json.value.map((v) => ({
        id: String(v.id ?? v.no ?? ""),
        display: String(v.display ?? v.displayName ?? v.name ?? ""),
        subtitle: v.subtitle ?? null,
        raw: v,
      })),
    };
  }
  return { items: [] };
}

const router = express.Router();

router.get("/matching/rules", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const items = await listMatchRules(req.workspace.id);
  res.json({ items });
}));

router.post("/matching/rules", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertMatchRule(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/matching/rules/:id", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertMatchRule(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.get("/document-links", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const items = await listDocumentLinks(req.workspace.id, req.query || {});
  res.json({ items });
}));

router.post("/document-links", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertDocumentLink(req.workspace.id, req.body || {});
  res.status(201).json({ item });
}));

router.post("/documents/:id/auto-match", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.DOCUMENTS_MANAGE), asyncHandler(async (req, res) => {
  const result = await runAutoMatchForDocument(req.workspace.id, req.params.id);
  res.json(result);
}));

router.get("/bc/targets", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const items = await listBcTargets(req.workspace.id);
  res.json({ items });
}));

router.post("/bc/targets", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertBcTarget(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/targets/:id", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertBcTarget(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.post("/bc/fields", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertBcField(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/fields/:id", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertBcField(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.get("/bc/mapping-profiles", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const items = await listMappingProfiles(req.workspace.id);
  res.json({ items });
}));

router.post("/bc/mapping-profiles", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertMappingProfile(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/mapping-profiles/:id", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertMappingProfile(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

/** Sugerencia heurística + IA opcional de rutas de extracción → campos BC. */
router.post("/bc/mapping-suggest", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const out = await suggestBcFieldMapping(req.workspace.id, req.body || {});
  res.json(out);
}));

/** Sincroniza un destino desde la extensión BC hacia BcTarget/BcField del workspace. */
router.post("/bc/import-erp-target", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const targetKey = req.body?.targetKey != null ? String(req.body.targetKey) : "";
  const item = await importErpTargetIntoWorkspace(req.workspace.id, targetKey);
  res.status(201).json({ item });
}));

/** Entornos BC SaaS (Admin API); verifica credenciales OAuth del workspace. */
router.get("/bc/erp/environments", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const items = await listBcEnvironments(req.workspace.id, { tenantId });
  res.json({ ok: true, items });
}));

/** Empresas del entorno BC (OData Company); no requiere GUID de empresa guardado. */
router.get("/bc/erp/companies", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const environment = typeof req.query.environment === "string" ? req.query.environment : undefined;
  const items = await listBcODataCompanies(req.workspace.id, {
    tenantId,
    environment,
  });
  res.json({ items });
}));

/** Proxy a la extensión AL: metadatos de destinos (parseva-api-bc). */
router.get("/bc/erp/targets", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  let r;
  try {
    r = await bcErpFetch(req.workspace.id, "/targets", { method: "GET" });
  } catch (err) {
    if (err && err.code === "BC_NOT_CONFIGURED") {
      const detail =
        err instanceof Error && err.message
          ? err.message
          : "Falta configurar tenant, entorno o companyId para Business Central";
      return res.status(503).json({
        error: detail,
        targets: [],
      });
    }
    throw err;
  }
  const text = await r.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!r.ok) {
    const msg = extractBcApiErrorMessage(json, text, r.status);
    throw new HttpError(r.status, msg);
  }
  res.json(normalizeBcTargetsPayload(json));
}));

/** Búsqueda de catálogo BC para lookouts manuales (typeahead). */
router.get("/bc/erp/lookups/:lookupRef", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.DOCUMENTS_MANAGE), asyncHandler(async (req, res) => {
  const lookupRef = req.params.lookupRef;
  const q = req.query.q != null ? String(req.query.q) : "";
  const top = req.query.top != null ? String(req.query.top) : "20";
  const path = buildErpLookupPath(lookupRef, q, top);
  let r;
  try {
    r = await bcErpFetch(req.workspace.id, path, { method: "GET" });
  } catch (err) {
    if (err && err.code === "BC_NOT_CONFIGURED") {
      return res.status(503).json({
        error: "Integración Business Central sin baseUrl",
        items: [],
      });
    }
    throw err;
  }
  const text = await r.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!r.ok) {
    const msg = extractBcApiErrorMessage(json, text, r.status);
    throw new HttpError(r.status, msg);
  }
  res.json(normalizeBcLookupItems(lookupRef, json));
}));

/** Vista previa del cuerpo POST /ingest para un documento. */
router.post("/bc/ingest-preview", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const documentId = req.body?.documentId;
  const mappingProfileId = req.body?.mappingProfileId;
  if (!documentId || !mappingProfileId) {
    throw new HttpError(400, "documentId y mappingProfileId son obligatorios");
  }
  const out = await buildBcIngestPreview(req.workspace.id, documentId, mappingProfileId);
  res.json(out);
}));

router.post("/bc/extensions/:bcTargetId", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const item = await upsertExtensionTarget(req.workspace.id, req.params.bcTargetId, req.body || {});
  res.json({ item });
}));

router.get("/bc/sync-events", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_READ), asyncHandler(async (req, res) => {
  const items = await listBcSyncEvents(req.workspace.id, req.query?.status ? String(req.query.status) : null);
  res.json({ items });
}));

router.post("/bc/sync-events", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.DOCUMENTS_MANAGE), asyncHandler(async (req, res) => {
  const item = await queueBcSync(req.workspace.id, req.body?.documentId, req.body?.mappingProfileId);
  await createAuditEvent({
    action: "bc.sync.queued",
    userId: req.dbUser.id,
    workspaceId: req.workspace.id,
    entityType: "BcSyncEvent",
    entityId: item.id,
    metadata: { documentId: item.documentId, mappingProfileId: item.mappingProfileId },
  });
  res.status(201).json({ item });
}));

router.post("/bc/sync-events/process", authenticateSession, requireWorkspaceContext, requirePermission(PERMISSIONS.CONFIG_WRITE), asyncHandler(async (req, res) => {
  const out = await processPendingBcSync(req.workspace.id, Number(req.body?.limit || 30));
  res.json(out);
}));

module.exports = router;
