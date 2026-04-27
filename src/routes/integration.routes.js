/**
 * @file Endpoints CRUD de `IntegrationConnection` (SharePoint, email, Business
 * Central, etc.) por workspace.
 *
 * @module routes/integration
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const {
  listIntegrations,
  createIntegration,
  updateIntegration,
} = require("../services/integration.service");
const { createAuditEvent } = require("../services/audit.service");

const router = express.Router();

router.get(
  "/integrations",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const items = await listIntegrations(req.dbUser.id, req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/integrations",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const integration = await createIntegration(
      req.dbUser.id,
      req.workspace.id,
      req.body || {}
    );
    await createAuditEvent({
      action: "integration.created",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "IntegrationConnection",
      entityId: integration.id,
      metadata: { kind: integration.kind, status: integration.status },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ integration });
  })
);

router.patch(
  "/integrations/:id",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const integration = await updateIntegration(
      req.dbUser.id,
      req.workspace.id,
      req.params.id,
      req.body || {}
    );
    await createAuditEvent({
      action: "integration.updated",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "IntegrationConnection",
      entityId: integration.id,
      metadata: { status: integration.status },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ integration });
  })
);

module.exports = router;
