# Invoicely — Backend

API HTTP del SaaS Invoicely. Construida sobre **Express 5**, **Prisma 7** (Postgres),
**Microsoft Graph** y **OpenAI**, lista para correr en local con `KAFKA_ENABLED=false`
o en producción con un broker Kafka real.

> La documentación end-to-end de la plataforma (visión, despliegue, licencias,
> integraciones) vive en el repositorio padre: **[../README.md](../README.md)**.
> Este README cubre la convención y los detalles del backend.

---

Levantar dockers:
KAFKA:
docker-compose -f docker-compose.yml -f docker-compose.kafka.yml up -d
POSTGRESS:
docker-compose -p invoicely up -d

## Tabla de contenidos

- [Stack](#stack)
- [Comandos](#comandos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Convenciones de código](#convenciones-de-código)
- [Variables de entorno](#variables-de-entorno)
- [Logging y observabilidad](#logging-y-observabilidad)
- [Workers en background](#workers-en-background)
- [Kafka local (opcional)](#kafka-local-opcional)

---

## Stack

| Área           | Librería                                          |
| -------------- | ------------------------------------------------- |
| Framework HTTP | `express` 5                                       |
| Auth           | `@azure/msal-node` + cookies firmadas (JWT HS256) |
| ORM            | `prisma` + `@prisma/adapter-pg`                   |
| Validación     | `zod`                                             |
| Observabilidad | `pino` + `pino-http` + `morgan`                   |
| Seguridad      | `helmet`, `express-rate-limit`, `cookie-parser`   |
| Mensajería     | `kafkajs` (opcional)                              |
| IA             | `openai` (Responses API + embeddings)             |
| Documentos     | `pdf-parse`                                       |

---

## Comandos

```bash
npm install
copy .env.example .env
npm run prisma:generate
npm run prisma:push          # primera vez en local
npm run dev                  # nodemon + .env
```

| Script                    | Descripción                              |
| ------------------------- | ---------------------------------------- |
| `npm run dev`             | Levanta el server con `nodemon`.         |
| `npm start`               | Producción (`node src/server.js`).       |
| `npm run prisma:generate` | Regenera el cliente Prisma.              |
| `npm run prisma:push`     | Sincroniza schema con la BD (sin migr.). |
| `npm run prisma:migrate`  | Crea/aplica migraciones.                 |
| `npm run prisma:studio`   | Abre Prisma Studio.                      |

---

## Estructura del proyecto

```
src/
├── app.js                  Construcción de la app Express (middlewares, routes).
├── server.js               Bootstrap del servidor + workers + graceful shutdown.
├── config/
│   ├── env.js              Carga y validación de variables de entorno (Zod).
│   └── msal.js             Cliente MSAL para login del usuario.
├── constants/              Strings tipados (status, kinds, audit actions, etc.)
├── lib/
│   ├── prisma.js           Singleton Prisma con adapter de PG.
│   ├── logger.js           Logger pino (JSON) con redacción de secretos.
│   ├── session.js          Firma/verificación de cookies de sesión.
│   ├── kafka.js            Productor/consumers con disconnect ordenado.
│   └── graph-client.js     Cliente Microsoft Graph (app-only).
├── middlewares/
│   ├── request-context.middleware.js   requestId + logger por request.
│   ├── session-auth.middleware.js      Auth por cookie de sesión.
│   ├── auth.middleware.js              Auth por Bearer (Azure AD JWT).
│   ├── workspace-context.middleware.js Membresía + helper combineAuth().
│   └── tenant.middleware.js            Modelo legacy (Tenant/Membership).
├── routes/                 Endpoints HTTP agrupados por dominio.
├── services/               Lógica de negocio (sin Express, testeable).
├── utils/                  Helpers reutilizables (asyncHandler, HttpError…).
└── workers/                Procesos en background (email, BC sync, Graph renew).
```

---

## Convenciones de código

- **CommonJS** (`require`/`module.exports`). No hay transpilación.
- **JSDoc** en módulos públicos (`@file`, `@typedef`, `@param`, `@returns`).
- **Sin `console.*`**: todo el logging va por `lib/logger.js` con un campo
  `component` que identifica la procedencia.
- **Errores HTTP** se modelan con `utils/http-error.js`. Los servicios lanzan
  `HttpError` y el manejador global responde JSON consistente.
- **Validación de entradas** con `zod` en cada handler que toca el body / query.
- **Constantes** en `src/constants/`. Nunca usar strings "mágicos" para status,
  kinds o acciones de auditoría.
- **Auditoría**: usar `auditFromRequest(req, partial)` cuando estás dentro de
  un handler para no repetir `userId`/`workspaceId`/IP/UA.
- **Composición de middlewares**: para rutas autenticadas con workspace usar
  `...combineAuth()`.

---

## Variables de entorno

Todas las envs se validan en `src/config/env.js`. Valores faltantes o fuera de
rango hacen que el proceso falle al arrancar (fail-fast). Ver `.env.example`
para la lista completa con descripciones; las más relevantes:

| Variable                | Default                 | Descripción                              |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `PORT`                  | `4000`                  | Puerto HTTP.                             |
| `NODE_ENV`              | `development`           | `development` / `test` / `production`.   |
| `MSAL_TENANT_ID`        | —                       | Tenant para login (puede ser `common`).  |
| `MSAL_CLIENT_ID/SECRET` | —                       | App registration de Azure AD.            |
| `SESSION_SECRET`        | —                       | Min. 16 chars; firma cookies de sesión.  |
| `FRONTEND_ORIGIN`       | `http://localhost:3000` | CORS allowlist + post-login redirect.    |
| `DATABASE_URL`          | —                       | Connection string de Postgres.           |
| `KAFKA_ENABLED`         | `false`                 | Habilita publicación en Kafka.           |
| `OPENAI_API_KEY`        | (vacío)                 | Sin clave se cae al stub determinista.   |
| `OPENAI_MODEL`          | `gpt-4o-mini`           | Modelo de chat por defecto.              |
| `OPENAI_EMBEDDING_DIMS` | `1536`                  | Debe coincidir con el `vector(N)` en BD. |
| `FLOW_WORKER_ENABLED`   | `true`                  | Toggle del worker de sync BC.            |

Para el flujo SaaS de consentimiento Microsoft 365 / Business Central, ver
[`docs/microsoft-saas-connectors.md`](docs/microsoft-saas-connectors.md).

---

## Logging y observabilidad

- Cada request entra por `requestContext()`: se asigna un `x-request-id`
  (acepta el del cliente) y se inyecta un logger `req.log` con `userId` y
  `workspaceId` cuando estén disponibles.
- Los workers usan `logger` con `component` (`email-worker`, `bc-sync-worker`,
  `graph-renewal`, `graph-webhook`, `invoice-extraction`, …) para facilitar el
  filtrado en producción.

---

## Workers en background

Tres procesos se arrancan junto con el server (todos cancelables en shutdown):

| Worker                              | Trigger                                 | Qué hace                                                     |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `email-worker`                      | Inline o Kafka                          | Procesa los `EmailJob` (extracción, matching, persistencia). |
| `graph-subscription-renewal.worker` | Interval cada `GRAPH_RENEW_INTERVAL_MS` | Renueva suscripciones de Graph antes del expiry.             |
| `bc-sync-worker`                    | Polling DB                              | Despacha eventos de sync hacia Business Central.             |

`SIGTERM`/`SIGINT` ⇒ se detienen los timers, se cierra Kafka y Prisma, y
finalmente el HTTP server (timeout duro de 10 s).

---

## Kafka local (opcional)

Con `KAFKA_ENABLED=true`, podés usar `docker-compose` (no incluido en este
subrepo) o tu propio broker. Topics:

- `email-processing-jobs` (principal)
- `email-processing-jobs.retry`
- `email-processing-jobs.dlq`

Sin Kafka, los jobs se procesan inline en el mismo proceso del API.
