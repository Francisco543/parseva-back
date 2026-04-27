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
} = require("../services/bc-mapping-studio.service");
const {
  queueBcSync,
  processPendingBcSync,
  listBcSyncEvents,
} = require("../services/bc-sync.service");

const router = express.Router();

router.get("/matching/rules", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const items = await listMatchRules(req.workspace.id);
  res.json({ items });
}));

router.post("/matching/rules", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertMatchRule(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/matching/rules/:id", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertMatchRule(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.get("/document-links", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const items = await listDocumentLinks(req.workspace.id, req.query || {});
  res.json({ items });
}));

router.post("/document-links", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertDocumentLink(req.workspace.id, req.body || {});
  res.status(201).json({ item });
}));

router.post("/documents/:id/auto-match", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const result = await runAutoMatchForDocument(req.workspace.id, req.params.id);
  res.json(result);
}));

router.get("/bc/targets", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const items = await listBcTargets(req.workspace.id);
  res.json({ items });
}));

router.post("/bc/targets", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertBcTarget(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/targets/:id", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertBcTarget(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.post("/bc/fields", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertBcField(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/fields/:id", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertBcField(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.get("/bc/mapping-profiles", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const items = await listMappingProfiles(req.workspace.id);
  res.json({ items });
}));

router.post("/bc/mapping-profiles", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertMappingProfile(req.workspace.id, null, req.body || {});
  res.status(201).json({ item });
}));

router.patch("/bc/mapping-profiles/:id", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertMappingProfile(req.workspace.id, req.params.id, req.body || {});
  res.json({ item });
}));

router.post("/bc/extensions/:bcTargetId", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const item = await upsertExtensionTarget(req.workspace.id, req.params.bcTargetId, req.body || {});
  res.json({ item });
}));

router.get("/bc/sync-events", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const items = await listBcSyncEvents(req.workspace.id, req.query?.status ? String(req.query.status) : null);
  res.json({ items });
}));

router.post("/bc/sync-events", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
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

router.post("/bc/sync-events/process", authenticateSession, requireWorkspaceContext, asyncHandler(async (req, res) => {
  const out = await processPendingBcSync(req.workspace.id, Number(req.body?.limit || 30));
  res.json(out);
}));

module.exports = router;
