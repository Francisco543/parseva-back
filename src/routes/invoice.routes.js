/**
 * @file Endpoints de lectura de facturas (`InvoiceRecord`) por workspace.
 * @module routes/invoice
 */

const express = require("express");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const { listInvoices } = require("../services/invoice.service");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

const router = express.Router();

router.get(
  "/invoices",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.DOCUMENTS_READ),
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.take) || 50, 100);
    const items = await listInvoices(req.workspace.id, { take });
    res.json({ items });
  })
);

module.exports = router;
