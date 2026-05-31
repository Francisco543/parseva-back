/**
 * @file CRUD de reglas de enrutado de aprobación por tipo documental.
 *
 * @module routes/approval-routing
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");
const asyncHandler = require("../utils/async-handler");
const {
  listApprovalRoutingRules,
  createApprovalRoutingRule,
  updateApprovalRoutingRule,
  deleteApprovalRoutingRule,
  getAllowedRoutingFieldKeys,
} = require("../services/approval-routing.service");

const router = express.Router();

router.get(
  "/workspace/approval-routing-rules/allowed-fields",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const documentTypeId = req.query.documentTypeId ? String(req.query.documentTypeId) : "";
    if (!documentTypeId) {
      return res.status(400).json({ message: "documentTypeId query requerido" });
    }
    const fieldKeys = await getAllowedRoutingFieldKeys(req.workspace.id, documentTypeId);
    res.json({ fieldKeys });
  })
);

router.get(
  "/workspace/approval-routing-rules",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const documentTypeId = req.query.documentTypeId ? String(req.query.documentTypeId) : "";
    if (!documentTypeId) {
      return res.status(400).json({ message: "documentTypeId query requerido" });
    }
    const items = await listApprovalRoutingRules(req.workspace.id, documentTypeId);
    res.json({ items });
  })
);

router.post(
  "/workspace/approval-routing-rules",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const item = await createApprovalRoutingRule(req.workspace.id, req.body || {});
    res.status(201).json({ item });
  })
);

router.patch(
  "/workspace/approval-routing-rules/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const item = await updateApprovalRoutingRule(req.workspace.id, req.params.id, req.body || {});
    res.json({ item });
  })
);

router.delete(
  "/workspace/approval-routing-rules/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    await deleteApprovalRoutingRule(req.workspace.id, req.params.id);
    res.json({ ok: true });
  })
);

module.exports = router;
