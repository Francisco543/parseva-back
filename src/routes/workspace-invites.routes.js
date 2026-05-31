/**
 * @file Invitaciones al workspace por correo (mismo tenant).
 * @module routes/workspace-invites
 */

const express = require("express");
const { z } = require("zod");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");
const asyncHandler = require("../utils/async-handler");
const { listInvites, createInvite, revokeInvite } = require("../services/workspace-invite.service");
const { createAuditEvent } = require("../services/audit.service");
const { AUDIT_ACTION } = require("../constants/audit-actions");

const router = express.Router();

const postInviteSchema = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(["ADMIN", "EDITOR", "VIEWER"]),
});

router.get(
  "/workspace/invites",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const { pending, acceptedRecent } = await listInvites(req.workspace.id);
    res.json({
      pending: pending.map(formatInvite),
      acceptedRecent: acceptedRecent.map(formatInvite),
    });
  })
);

router.post(
  "/workspace/invites",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const parsed = postInviteSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "email y role (ADMIN|EDITOR|VIEWER) son requeridos" });
    }

    const row = await createInvite(req.workspace.id, {
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: req.dbUser.id,
    });

    await createAuditEvent({
      action: AUDIT_ACTION.WORKSPACE_INVITE_CREATED,
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "WorkspaceInvite",
      entityId: row.id,
      metadata: { email: row.email, role: row.role },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(201).json({ invite: formatInvite(row) });
  })
);

router.delete(
  "/workspace/invites/:id",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const before = await revokeInvite(req.workspace.id, req.params.id);

    await createAuditEvent({
      action: AUDIT_ACTION.WORKSPACE_INVITE_REVOKED,
      userId: req.dbUser.id,
      workspaceId: req.workspace.id,
      entityType: "WorkspaceInvite",
      entityId: before.id,
      metadata: { email: before.email },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({ ok: true });
  })
);

/** @param {any} row */
function formatInvite(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedByUserId: row.invitedByUserId,
    invitedBy: row.invitedBy
      ? {
          id: row.invitedBy.id,
          email: row.invitedBy.email,
          fullName: row.invitedBy.fullName,
        }
      : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    acceptedByUserId: row.acceptedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

module.exports = router;
