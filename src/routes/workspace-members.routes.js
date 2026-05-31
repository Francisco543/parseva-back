/**
 * @file Miembros del workspace y asignación de roles.
 * @module routes/workspace-members
 */

const express = require("express");
const { z } = require("zod");

const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireWorkspaceContext } = require("../middlewares/workspace-context.middleware");
const { PERMISSIONS } = require("../constants/rbac");
const { requirePermission } = require("../middlewares/rbac.middleware");
const asyncHandler = require("../utils/async-handler");
const { listMembers, updateMemberRole } = require("../services/workspace-members.service");
const { createAuditEvent } = require("../services/audit.service");
const { AUDIT_ACTION } = require("../constants/audit-actions");

const router = express.Router();

const patchRoleSchema = z.object({
  role: z.enum(["ADMIN", "EDITOR", "VIEWER"]),
});

router.get(
  "/workspace/members",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_READ),
  asyncHandler(async (req, res) => {
    const items = await listMembers(req.workspace.id);
    res.json({ items });
  })
);

router.patch(
  "/workspace/members/:membershipId/role",
  authenticateSession,
  requireWorkspaceContext,
  requirePermission(PERMISSIONS.CONFIG_WRITE),
  asyncHandler(async (req, res) => {
    const parsed = patchRoleSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Body inválido: se requiere role (ADMIN|EDITOR|VIEWER)" });
    }

    const out = await updateMemberRole({
      workspaceId: req.workspace.id,
      membershipId: req.params.membershipId,
      nextRole: parsed.data.role,
    });

    if (out.changed) {
      await createAuditEvent({
        action: AUDIT_ACTION.WORKSPACE_MEMBERSHIP_ROLE_UPDATED,
        userId: req.dbUser.id,
        workspaceId: req.workspace.id,
        entityType: "WorkspaceMembership",
        entityId: out.membership.id,
        metadata: {
          targetUserId: out.membership.userId,
          previousRole: out.previousRole,
          newRole: out.membership.role,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }

    res.json({ membership: out.membership });
  })
);

module.exports = router;
