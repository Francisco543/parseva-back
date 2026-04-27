/**
 * @file Endpoints del modelo legacy "Tenant/Membership" (predecesor del
 * modelo Workspace). Se mantiene mientras se completa la migración para no
 * romper clientes que aún lo consumen.
 *
 * @module routes/tenant
 */

const express = require("express");
const asyncHandler = require("../utils/async-handler");
const {
  createTenantForUser,
  listTenantsForUser,
} = require("../services/tenant.service");
const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { requireTenantContext } = require("../middlewares/tenant.middleware");

const router = express.Router();

router.get(
  "/tenants",
  authenticateSession,
  asyncHandler(async (req, res) => {
    const memberships = await listTenantsForUser(req.dbUser.id);

    res.json({
      items: memberships.map((membership) => ({
        role: membership.role,
        tenant: membership.tenant,
      })),
    });
  })
);

router.post(
  "/tenants",
  authenticateSession,
  asyncHandler(async (req, res) => {
    const { name, slug } = req.body || {};
    const tenant = await createTenantForUser({
      userId: req.dbUser.id,
      name,
      slug,
    });

    res.status(201).json({ tenant });
  })
);

router.get(
  "/tenant-context",
  authenticateSession,
  requireTenantContext,
  asyncHandler(async (req, res) => {
    res.json({
      tenant: req.tenant,
      membership: {
        id: req.membership.id,
        role: req.membership.role,
      },
    });
  })
);

module.exports = router;
