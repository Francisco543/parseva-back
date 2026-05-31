/**
 * @file Punto de montaje de todos los routers de la API bajo el prefijo `/api`.
 *
 * El orden de registro no afecta a la lógica (cada subrouter define su path),
 * pero se mantiene agrupado por dominio funcional para facilitar la lectura.
 *
 * @module routes
 */

const express = require("express");

const healthRoutes = require("./health.routes");
const authRoutes = require("./auth.routes");
const integrationRoutes = require("./integration.routes");
const emailAutomationRoutes = require("./email-automation.routes");
const emailGraphRoutes = require("./email-graph.routes");
const workspaceAutomationRoutes = require("./workspace-automation.routes");
const sharepointRoutes = require("./sharepoint.routes");
const invoiceRoutes = require("./invoice.routes");
const auditRoutes = require("./audit.routes");
const documentRoutes = require("./document.routes");
const studioRoutes = require("./studio.routes");
const workspaceMembersRoutes = require("./workspace-members.routes");
const workspaceInvitesRoutes = require("./workspace-invites.routes");
const approvalRoutingRoutes = require("./approval-routing.routes");
const { authenticateSession } = require("../middlewares/session-auth.middleware");

const router = express.Router();

router.use("/api", healthRoutes);
router.use("/api", authRoutes);
router.use("/api", integrationRoutes);
router.use("/api", emailAutomationRoutes);
router.use("/api", emailGraphRoutes);
router.use("/api", workspaceAutomationRoutes);
router.use("/api", sharepointRoutes);
router.use("/api", invoiceRoutes);
router.use("/api", auditRoutes);
router.use("/api", documentRoutes);
router.use("/api", studioRoutes);
router.use("/api", workspaceMembersRoutes);
router.use("/api", workspaceInvitesRoutes);
router.use("/api", approvalRoutingRoutes);

router.get("/api/protected", authenticateSession, (req, res) => {
  res.json({
    message: "Acceso permitido",
    user: {
      oid: req.user.oid,
      name: req.user.name,
      preferred_username: req.user.preferred_username,
    },
    dbUser: req.dbUser,
  });
});

module.exports = router;
