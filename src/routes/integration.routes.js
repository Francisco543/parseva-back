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
const {
  buildAdminConsentUrl,
  handleAdminConsentCallback,
} = require("../services/microsoft-consent.service");
const {
  getGraphConnectorStatus,
  getBusinessCentralStatus,
} = require("../services/microsoft-health.service");
const { createAuditEvent } = require("../services/audit.service");
const env = require("../config/env");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

const router = express.Router();

function consentRedirectUrl(result) {
  const base = String(env.msalPostLoginRedirectUri || env.frontendOrigin).replace(/\/+$/, "");
  const params = new URLSearchParams({
    tab: result.connector === "bc" ? "bc" : "email",
    consent: result.ok ? "ok" : "error",
    connector: result.connector,
  });
  if (result.tenantId) params.set("tenantId", result.tenantId);
  if (result.error) params.set("error", result.error);
  return `${base}/?${params.toString()}`;
}

router.get(
  "/integrations",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listIntegrations(req.workspace.id);
    res.json({ items });
  })
);

router.get(
  "/integrations/graph/admin-consent/url",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const out = await buildAdminConsentUrl({
      connector: "graph",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
    });
    res.json(out);
  })
);

router.get(
  "/integrations/bc/admin-consent/url",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const out = await buildAdminConsentUrl({
      connector: "bc",
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
    });
    res.json(out);
  })
);

router.get(
  "/integrations/graph/admin-consent/callback",
  asyncHandler(async (req, res) => {
    const result = await handleAdminConsentCallback({
      connector: "graph",
      query: req.query || {},
    });
    res.redirect(consentRedirectUrl(result));
  })
);

router.get(
  "/integrations/bc/admin-consent/callback",
  asyncHandler(async (req, res) => {
    const result = await handleAdminConsentCallback({
      connector: "bc",
      query: req.query || {},
    });
    res.redirect(consentRedirectUrl(result));
  })
);

router.get(
  "/integrations/graph/status",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const status = await getGraphConnectorStatus(req.workspace, req.dbUser.id);
    res.json(status);
  })
);

router.get(
  "/integrations/bc/status",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const status = await getBusinessCentralStatus(req.workspace);
    res.json(status);
  })
);

router.post(
  "/integrations",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
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
  requirePermission(PERMISSIONS.CONFIG_WRITE),
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
