/**
 * @file Endpoints de ingestión de eventos de email y consulta del estado de
 * los `EmailJob` del workspace.
 *
 * - `POST /email/events`: ingesta sincrónica (también la utiliza el handler
 *   del webhook de Graph indirectamente).
 * - `GET  /email/jobs`:   lista jobs paginada (usado por el dashboard).
 *
 * @module routes/email-automation
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const {
  ingestEmailEvent,
  listEmailJobs,
} = require("../services/email-automation.service");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

const router = express.Router();

router.post(
  "/email/events",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_MANAGE),
  asyncHandler(async (req, res) => {
    const result = await ingestEmailEvent(
      req.dbUser.id,
      req.workspace.id,
      req.body || {}
    );
    res.status(202).json({
      accepted: true,
      enqueued: result.enqueued,
      emailMessageId: result.emailMessage.id,
      jobId: result.job.id,
    });
  })
);

router.get(
  "/email/jobs",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const items = await listEmailJobs(req.dbUser.id, req.workspace.id);
    res.json({ items });
  })
);

module.exports = router;
