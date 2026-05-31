/**
 * @file Endpoint de health check.
 *
 * Devuelve `200 ok` cuando se puede ejecutar una query trivial contra la base
 * de datos, o `503 degraded` en caso contrario. Pensado para ser llamado por
 * load balancers, Kubernetes liveness/readiness probes y monitoreo externo.
 *
 * @module routes/health
 */

const path = require("node:path");
const fs = require("node:fs");

const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

router.get("/openapi.json", (_req, res) => {
  try {
    const specPath = path.join(__dirname, "..", "openapi", "openapi.json");
    const raw = fs.readFileSync(specPath, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ message: "Especificación OpenAPI no disponible" });
  }
});

router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: "ok", db: "up" });
  } catch (_err) {
    return res.status(503).json({ status: "degraded", db: "down" });
  }
});

module.exports = router;
