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
const { createAuditEvent } = require("../services/audit.service");

const router = express.Router();

router.get(
  "/workspace/automation",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const settings = await getAutomationSettings(req.workspace.id);
    res.json({ settings });
  })
);

router.patch(
  "/workspace/automation",
  authenticateSession,
  requireWorkspaceContext,
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

module.exports = router;
