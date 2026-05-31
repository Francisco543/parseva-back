/**
 * @file Endpoints relacionados con SharePoint (resolución de sitios, drives).
 * @module routes/sharepoint
 */

const express = require("express");
const { z } = require("zod");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const asyncHandler = require("../utils/async-handler");
const prisma = require("../lib/prisma");
const { resolveSiteFromUrl } = require("../services/sharepoint.service");
const HttpError = require("../utils/http-error");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");

const router = express.Router();

const resolveSchema = z.object({
  siteUrl: z.string().url(),
});

router.post(
  "/sharepoint/resolve-site",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const parsed = resolveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      throw new HttpError(400, "siteUrl requerido y debe ser una URL valida");
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: req.workspace.id },
    });
    if (!workspace) throw new HttpError(404, "Workspace not found");

    const resolved = await resolveSiteFromUrl(
      workspace.aadTenantId,
      parsed.data.siteUrl
    );

    res.json({ resolved, siteUrl: parsed.data.siteUrl });
  })
);

module.exports = router;
