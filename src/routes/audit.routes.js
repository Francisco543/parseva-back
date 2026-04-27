/**
 * @file Endpoint de listado de eventos de auditoría por workspace.
 * @module routes/audit
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const { listAuditEvents } = require("../services/audit.service");

const router = express.Router();

router.get(
  "/audit/events",
  authenticateSession,
  requireWorkspaceContext,
  asyncHandler(async (req, res) => {
    const take = Math.min(200, Math.max(1, Number(req.query.take || 50)));
    const skip = Math.max(0, Number(req.query.skip || 0));
    const { items, total } = await listAuditEvents(req.dbUser.id, req.workspace.id, {
      take,
      skip,
    });
    res.json({ items, total, take, skip });
  })
);

module.exports = router;
