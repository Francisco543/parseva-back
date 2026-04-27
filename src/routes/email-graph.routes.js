/**
 * @file Endpoints relacionados con Microsoft Graph (webhooks de buzones,
 * suscripciones, diagnósticos).
 *
 * El endpoint `POST /email/graph/webhook` se llama directamente desde Microsoft Graph
 * y debe respetar el contrato de validación (`validationToken` en query string)
 * y de notificación (responder rápido y procesar en background).
 *
 * @module routes/email-graph
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const {
  createGraphSubscription,
  listGraphSubscriptions,
  handleGraphNotification,
  diagnoseMailbox,
  getWebhookDiagnostics,
} = require("../services/email-graph.service");
const { createAuditEvent } = require("../services/audit.service");
const { logger } = require("../lib/logger");
const { AUDIT_ACTION } = require("../constants");

const router = express.Router();

router.get("/email/graph/webhook", (req, res) => {
  const validationToken = req.query.validationToken;
  if (validationToken) {
    return res.status(200).type("text/plain").send(String(validationToken));
  }
  return res.status(200).json({ ok: true });
});

router.post(
  "/email/graph/webhook",
  asyncHandler(async (req, res) => {
    const validationToken = req.query.validationToken;
    if (validationToken) {
      return res.status(200).type("text/plain").send(String(validationToken));
    }

    // Microsoft Graph espera 2xx rápido; el procesamiento se hace fuera del ciclo de respuesta.
    res.status(202).json({ accepted: true });
    try {
      await handleGraphNotification(req.body || {});
    } catch (error) {
      logger.error(
        {
          component: "graph-webhook",
          err: error instanceof Error ? error.message : String(error),
        },
        "notification handler failed"
      );
    }
  })
);

router.get(
  "/email/graph/subscriptions",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const items = await listGraphSubscriptions(req.dbUser.id, req.workspace.id);
    res.json({ items });
  })
);

router.post(
  "/email/graph/subscriptions",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const subscription = await createGraphSubscription(
      req.dbUser.id,
      req.workspace.id,
      req.body || {}
    );
    await createAuditEvent({
      action: AUDIT_ACTION.GRAPH_SUBSCRIPTION_CREATED,
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "EmailGraphSubscription",
      entityId: subscription.id,
      metadata: {
        integrationId: subscription.integrationId,
        subscriptionId: subscription.subscriptionId,
        resource: subscription.resource,
        expirationDateTime: subscription.expirationDateTime,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ subscription });
  })
);

router.get(
  "/email/graph/webhook-diagnostics",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const report = await getWebhookDiagnostics(req.dbUser.id, req.workspace.id);
    res.json(report);
  })
);

router.get(
  "/email/graph/diagnose-mailbox",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const mailbox = String(req.query.mailbox || "").trim().toLowerCase();
    if (!mailbox) {
      return res.status(400).json({ message: "mailbox query param is required" });
    }

    const result = await diagnoseMailbox(req.workspace.id, mailbox);
    return res.json(result);
  })
);

module.exports = router;
