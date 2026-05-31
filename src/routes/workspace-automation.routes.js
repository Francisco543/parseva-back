/**
 * @file Endpoints de configuración de automatización del workspace
 * (SharePoint, plantilla de ruta, extracción IA).
 * @module routes/workspace-automation
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const {
  getAutomationSettings,
  updateAutomationSettings,
} = require("../services/workspace-automation.service");
const {
  listOutgoingWebhooks,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
} = require("../services/workspace-webhook.service");
const {
  listWorkspaceApiKeys,
  createWorkspaceApiKey,
  deleteWorkspaceApiKey,
} = require("../services/workspace-api-key.service");
const { createAuditEvent } = require("../services/audit.service");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

const router = express.Router();

router.get(
  "/workspace/automation",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const settings = await getAutomationSettings(req.workspace.id);
    res.json({ settings });
  })
);

router.patch(
  "/workspace/automation",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const settings = await updateAutomationSettings(req.workspace.id, req.body || {});

    await createAuditEvent({
      action: "automation.settings.updated",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "Workspace",
      entityId: req.workspace.id,
      metadata: {
        sharepointIntegrationId: settings.sharepointIntegrationId || null,
        pathTemplate: settings.pathTemplate,
        rootFolder: settings.rootFolder,
        extractionEnabled: settings.extractionEnabled,
        openaiModel: settings.openaiModel,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({ settings });
  })
);

router.get(
  "/workspace/outgoing-webhooks",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listOutgoingWebhooks(req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/workspace/outgoing-webhooks",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const created = await createOutgoingWebhook(req.workspace.id, req.body || {});
    await createAuditEvent({
      action: "workspace.webhook.created",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "OutgoingWebhook",
      entityId: created.id,
      metadata: { url: created.url },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(created);
  })
);

router.delete(
  "/workspace/outgoing-webhooks/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    await deleteOutgoingWebhook(req.workspace.id, req.params.id);
    res.json({ ok: true });
  })
);

router.get(
  "/workspace/api-keys",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listWorkspaceApiKeys(req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/workspace/api-keys",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const out = await createWorkspaceApiKey(req.workspace.id, req.body || {});
    await createAuditEvent({
      action: "workspace.api_key.created",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "WorkspaceApiKey",
      entityId: out.apiKey.id,
      metadata: { name: out.apiKey.name, keyPrefix: out.apiKey.keyPrefix },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ apiKey: out.apiKey, plainKey: out.plainKey });
  })
);

router.delete(
  "/workspace/api-keys/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    await deleteWorkspaceApiKey(req.workspace.id, req.params.id);
    res.json({ ok: true });
  })
);

module.exports = router;
