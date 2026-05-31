/**
 * @file Endpoints relacionados con el dominio de documentos:
 *  - Tipos de documento (CRUD ligero, sugerencias de schema vía IA).
 *  - Listado/detalle de documentos.
 *  - Aprobación/rechazo manual de documentos.
 *  - Mapeos de Business Central asociados a un tipo de documento.
 *
 * @module routes/document
 */

const express = require("express");
const multer = require("multer");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const { createAuditEvent } = require("../services/audit.service");

const {
  listDocumentTypes,
  createDocumentType,
  patchDocumentType,
  suggestDocumentTypeExtractionSchema,
  ensureWorkspaceDefaultDocumentTypes,
} = require("../services/document-type.service");

const {
  listDocuments,
  getDocument,
  getDocumentFileBuffer,
  getDocumentLayout,
  archiveDocumentToSharePoint,
  patchDocumentExtraction,
  patchDocumentBcStaging,
} = require("../services/document.service");
const { ingestManualPdfs } = require("../services/manual-document-ingest.service");
const { reprocessDocument } = require("../services/document-reprocess.service");
const { approveDocument, rejectDocument } = require("../services/approval.service");
const { listMappings, upsertMapping } = require("../services/business-central-mapping.service");
const { listDocumentNotes, createDocumentNote } = require("../services/document-note.service");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");
const router = express.Router();

const manualUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 25 },
});

// Document types (configurable)
router.get(
  "/document-types",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listDocumentTypes(req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/document-types",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const created = await createDocumentType(req.workspace.id, req.body || {});
    await createAuditEvent({
      action: "document.type.created",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentType",
      entityId: created.id,
      metadata: { key: created.key, enabled: created.enabled },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ documentType: created });
  })
);

router.patch(
  "/document-types/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const updated = await patchDocumentType(req.workspace.id, req.params.id, req.body || {});
    await createAuditEvent({
      action: "document.type.updated",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentType",
      entityId: updated.id,
      metadata: { key: updated.key, enabled: updated.enabled },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ documentType: updated });
  })
);

router.post(
  "/document-types/seed-defaults",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const forceRefresh = req.body?.forceRefresh === true;
    const summary = await ensureWorkspaceDefaultDocumentTypes(req.workspace.id, { forceRefresh });
    await createAuditEvent({
      action: "document.type.updated",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "Workspace",
      entityId: req.workspace.id,
      metadata: {
        op: "seed_defaults",
        ...summary,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ summary });
  })
);

router.post(
  "/document-types/:id/suggest-extraction-schema",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const result = await suggestDocumentTypeExtractionSchema(
      req.workspace.id,
      req.params.id,
      req.body || {}
    );
    res.json(result);
  })
);

// Documents
router.get(
  "/documents",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const items = await listDocuments(req.dbUser.id, req.workspace.id, req.query || {});
    res.json({ items });
  })
);

router.post(
  "/documents/upload",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  manualUpload.array("files", 25),
  asyncHandler(async (req, res) => {
    const files = req.files;
    const forcedId =
      typeof req.body?.documentTypeId === "string" && req.body.documentTypeId.trim()
        ? req.body.documentTypeId.trim()
        : undefined;
    const result = await ingestManualPdfs({
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      files: Array.isArray(files) ? files : [],
      forcedDocumentTypeId: forcedId,
    });
    await createAuditEvent({
      action: "document.manual_upload.completed",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "Workspace",
      entityId: req.workspace.id,
      metadata: {
        fileCount: Array.isArray(files) ? files.length : 0,
        okCount: result.results.filter((r) => r.ok).length,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(result);
  })
);

router.post(
  "/documents/:id/reprocess",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const forced =
      typeof req.body?.documentTypeId === "string" && req.body.documentTypeId.trim()
        ? req.body.documentTypeId.trim()
        : undefined;
    const result = await reprocessDocument(req.dbUser.id, req.workspace.id, req.params.id, {
      forcedDocumentTypeId: forced,
    });
    await createAuditEvent({
      action: "document.reprocessed",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: req.params.id,
      metadata: {
        ok: result.results?.[0]?.ok ?? false,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json(result);
  })
);

router.get(
  "/documents/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const item = await getDocument(req.dbUser.id, req.workspace.id, req.params.id);
    res.json({ document: item });
  })
);

router.get(
  "/documents/:id/content",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const { buffer, contentType, fileName } = await getDocumentFileBuffer(
      req.dbUser.id,
      req.workspace.id,
      req.params.id
    );
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(fileName || "documento")}`
    );
    res.send(buffer);
  })
);

router.get(
  "/documents/:id/layout",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const layout = await getDocumentLayout(
      req.dbUser.id,
      req.workspace.id,
      req.params.id
    );
    res.json({ layout });
  })
);

router.post(
  "/documents/:id/archive-sharepoint",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const result = await archiveDocumentToSharePoint(
      req.dbUser.id,
      req.workspace.id,
      req.params.id
    );
    res.json(result);
  })
);

router.post(
  "/documents/:id/approve",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const { document, approval } = await approveDocument(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {},
      req.workspaceMembership?.role
    );
    await createAuditEvent({
      action: "approval.approved",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: document.id,
      metadata: { approvalId: approval.id },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    if (document.status === "ERP_QUEUED") {
      await createAuditEvent({
        action: "erp.queued",
        userId: req.dbUser.id,
        workspaceId: req.workspace.id,
        entityType: "DocumentRecord",
        entityId: document.id,
        metadata: { reason: "approved" },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }
    res.json({ document, approval });
  })
);

router.post(
  "/documents/:id/reject",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const { document, approval } = await rejectDocument(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {},
      req.workspaceMembership?.role
    );
    await createAuditEvent({
      action: "approval.rejected",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: document.id,
      metadata: { approvalId: approval.id },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ document, approval });
  })
);

router.get(
  "/documents/:id/notes",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const items = await listDocumentNotes(req.dbUser.id, req.workspace.id, req.params.id);
    res.json({ items });
  })
);

router.post(
  "/documents/:id/notes",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const note = await createDocumentNote(req.dbUser.id, req.workspace.id, req.params.id, req.body || {});
    await createAuditEvent({
      action: "document.note.created",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: req.params.id,
      metadata: { noteId: note.id },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ note });
  })
);

router.patch(
  "/documents/:id/extraction",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const document = await patchDocumentExtraction(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {}
    );
    await createAuditEvent({
      action: "document.extraction.patched",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: document.id,
      metadata: { keys: Object.keys(req.body?.fields || {}) },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ document });
  })
);

router.patch(
  "/documents/:id/bc-staging",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const document = await patchDocumentBcStaging(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {}
    );
    await createAuditEvent({
      action: "document.bc_staging.patched",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "DocumentRecord",
      entityId: document.id,
      metadata: { keys: Object.keys(req.body?.fields || {}) },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ document });
  })
);

// Business Central mappings (config solamente)
router.get(
  "/business-central/mappings",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listMappings(req.workspace.id);
    res.json({ items });
  })
);

router.patch(
  "/business-central/mappings",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const mapping = await upsertMapping(req.workspace.id, req.body || {});
    await createAuditEvent({
      action: "business_central.mapping.updated",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "BusinessCentralMapping",
      entityId: mapping.id,
      metadata: { documentTypeId: mapping.documentTypeId, enabled: mapping.enabled, targetTable: mapping.targetTable },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ mapping });
  })
);

module.exports = router;

