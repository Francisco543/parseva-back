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

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const { createAuditEvent } = require("../services/audit.service");

const {
  listDocumentTypes,
  createDocumentType,
  patchDocumentType,
  suggestDocumentTypeExtractionSchema,
} = require("../services/document-type.service");

const { listDocuments, getDocument } = require("../services/document.service");
const { approveDocument, rejectDocument } = require("../services/approval.service");
const { listMappings, upsertMapping } = require("../services/business-central-mapping.service");

const router = express.Router();

// Document types (configurable)
router.get(
  "/document-types",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const items = await listDocumentTypes(req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/document-types",
  authenticateSession,
  requireWorkspaceContext,
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
  "/document-types/:id/suggest-extraction-schema",
  authenticateSession,
  requireWorkspaceContext,
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
  asyncHandler(async (req, res) => {
    const items = await listDocuments(req.dbUser.id, req.workspace.id, req.query || {});
    res.json({ items });
  })
);

router.get(
  "/documents/:id",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const item = await getDocument(req.dbUser.id, req.workspace.id, req.params.id);
    res.json({ document: item });
  })
);

router.post(
  "/documents/:id/approve",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const { document, approval } = await approveDocument(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {}
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
  asyncHandler(async (req, res) => {
    const { document, approval } = await rejectDocument(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {}
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

// Business Central mappings (config solamente)
router.get(
  "/business-central/mappings",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const items = await listMappings(req.workspace.id);
    res.json({ items });
  })
);

router.patch(
  "/business-central/mappings",
  authenticateSession,
  requireWorkspaceContext,
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

