/**
 * @file Construcción de la aplicación Express.
 *
 * Pipeline de middlewares (en orden):
 *  1. CORS configurado al `FRONTEND_ORIGIN` con credenciales.
 *  2. Helmet (cabeceras de seguridad).
 *  3. Rate limit global (200 req cada 15min). Se omite el webhook de Graph
 *     porque es un servicio externo que requiere respuesta sin throttle.
 *  4. Logger HTTP (morgan en dev) + contexto pino con `requestId`.
 *  5. Parseo de JSON y cookies.
 *  6. Routers de la API (`/api/*`).
 *  7. Manejador global de errores → respuesta JSON consistente.
 *
 * El servidor HTTP se levanta en `server.js`.
 *
 * @module app
 */

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("express-rate-limit");

const env = require("./config/env");
const routes = require("./routes");
const { requestContext } = require("./middlewares/request-context.middleware");

const app = express();

app.use(
  cors({
    origin: env.frontendOrigin,
    credentials: true,
  })
);
app.use(helmet());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => {
      const url = req.originalUrl || "";
      return url.includes("/email/graph/webhook") && req.method === "POST";
    },
  })
);
app.use(morgan("dev"));
app.use(express.json());
app.use(cookieParser());
app.use(...requestContext());
app.use(routes);

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || "Unexpected server error",
    detail: err.details || (env.nodeEnv === "production" ? null : err.stack) || null,
  });
});

module.exports = app;
