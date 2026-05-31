const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const env = require("../config/env");
const { logger } = require("../lib/logger");
const { bcErpPostIngest, getBusinessCentralIntegration, resolveBcBearerToken } = require("./bc-erp-client.service");
const {
  mergeExtractionForBc,
  buildOperationsFromProfiles,
  listMissingRequiredBcFields,
} = require("./bc-ingest-build.service");

function isRetryable(err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("timeout") || msg.includes("429") || msg.includes("rate") || msg.includes("abort");
}

/**
 * Destinos EXTENSION requieren fila `BcExtensionTarget`.
 * Si falta o quedó PENDING (p. ej. perfiles viejos o segundo perfil sin reimport),
 * se auto-aprueba: el workspace ya eligió ese destino en un perfil y el envío es explícito.
 * Solo se bloquea si hubo rechazo explícito.
 *
 * @param {import("@prisma/client").BcMappingProfile & { bcTarget: import("@prisma/client").BcTarget }} profile
 * @param {string} workspaceId
 */
async function assertExtensionApproved(profile, workspaceId) {
  if (profile.bcTarget.mode !== "EXTENSION") return;
  const ext = await prisma.bcExtensionTarget.findFirst({
    where: { workspaceId, bcTargetId: profile.bcTargetId },
  });
  if (ext?.approvalStatus === "REJECTED") {
    const key = profile.bcTarget?.key ? String(profile.bcTarget.key) : profile.bcTargetId;
    throw new HttpError(
      409,
      `El destino BC de extensión «${key}» está rechazado. Reimportá el destino desde el catálogo o aprobá con POST /api/bc/extensions/:bcTargetId.`,
    );
  }
  if (!ext || ext.approvalStatus !== "APPROVED") {
    await prisma.bcExtensionTarget.upsert({
      where: { bcTargetId: profile.bcTargetId },
      create: {
        workspaceId,
        bcTargetId: profile.bcTargetId,
        approvalStatus: "APPROVED",
        sourceSchema: null,
        reviewerUserId: null,
        reviewNote: "Auto-aprobado al encolar sync (perfil BC habilitado para este tipo)",
      },
      update: {
        approvalStatus: "APPROVED",
        reviewNote: "Auto-aprobado al encolar sync (perfil BC habilitado para este tipo)",
      },
    });
  }
}

/**
 * Encola sync BC: agrupa todos los perfiles del mismo tipo documental (syncOrder)
 * en un único evento con `operations[]`.
 *
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {string} mappingProfileId perfil “ancla” (política BC del tipo u origen manual)
 */
async function queueBcSync(workspaceId, documentId, mappingProfileId) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const anchor = await prisma.bcMappingProfile.findFirst({
    where: { id: mappingProfileId, workspaceId, enabled: true },
    include: { bcTarget: true },
  });
  if (!anchor) throw new HttpError(404, "BC mapping profile not found");
  if (!anchor.bcTarget?.enabled) throw new HttpError(409, "BC target is disabled");

  /** @type {Array<typeof anchor>} */
  let profiles;
  if (doc.documentTypeId) {
    profiles = await prisma.bcMappingProfile.findMany({
      where: {
        workspaceId,
        documentTypeId: doc.documentTypeId,
        enabled: true,
      },
      orderBy: [{ syncOrder: "asc" }, { createdAt: "asc" }],
      include: { bcTarget: true },
    });
    if (!profiles.some((p) => p.id === anchor.id)) {
      throw new HttpError(400, "El perfil no pertenece al tipo documental del documento");
    }
  } else {
    profiles = [anchor];
  }

  for (const p of profiles) {
    await assertExtensionApproved(p, workspaceId);
  }

  const merged = mergeExtractionForBc(doc);
  const missing = await listMissingRequiredBcFields(workspaceId, profiles, merged);
  if (missing.length > 0) {
    throw new HttpError(409, `Campos BC obligatorios pendientes: ${missing.slice(0, 8).join("; ")}`);
  }

  const operations = buildOperationsFromProfiles(profiles, merged);
  const fingerprint = profiles
    .map((p) => p.id)
    .slice()
    .sort()
    .join(",");

  const existingOpen = await prisma.bcSyncEvent.findFirst({
    where: {
      workspaceId,
      documentId: doc.id,
      mappingProfileId: anchor.id,
      status: { in: ["PENDING", "SENT"] },
    },
  });
  if (existingOpen) return existingOpen;

  const event = await prisma.bcSyncEvent.create({
    data: {
      workspaceId,
      documentId: doc.id,
      mappingProfileId: anchor.id,
      status: "PENDING",
      attempt: 0,
      requestJson: {
        version: 1,
        documentId: doc.id,
        profileIds: profiles.map((p) => p.id),
        operationsFingerprint: fingerprint,
        operations,
        legacy: {
          targetKey: anchor.bcTarget.key,
          fieldMap: anchor.fieldMap,
          extractionJson: doc.extractionJson || {},
          bcStagingJson: doc.bcStagingJson || {},
        },
      },
    },
  });

  await prisma.documentRecord.update({
    where: { id: doc.id },
    data: { status: "ERP_QUEUED" },
  });

  const { isKafkaEnabled, publishBcSyncJob } = require("../lib/kafka");
  const { createAuditEvent } = require("./audit.service");
  const { AUDIT_ACTION } = require("../constants/audit-actions");

  if (isKafkaEnabled()) {
    const published = await publishBcSyncJob({
      eventId: event.id,
      workspaceId,
      documentId: doc.id,
      mappingProfileId: anchor.id,
    });
    await createAuditEvent({
      action: published ? AUDIT_ACTION.BC_SYNC_KAFKA_PUBLISHED : AUDIT_ACTION.BC_SYNC_KAFKA_PUBLISH_FAILED,
      workspaceId,
      entityType: "BcSyncEvent",
      entityId: event.id,
      metadata: {
        documentId: doc.id,
        mappingProfileId: anchor.id,
        kafkaTopic: env.kafkaBcSyncTopic,
        published,
      },
    });
  }

  return event;
}

/**
 * Respuesta OData POST `ingest` → JSON interno en `responsePayload`.
 *
 * @param {unknown} raw
 */
function normalizeBcIngestResponse(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.accepted === "boolean") return raw;
  let row = raw;
  if (Array.isArray(o.value) && o.value.length > 0) row = o.value[0];
  const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
  const payload = r.responsePayload ?? r.response_payload;
  if (typeof payload === "string" && payload.trim().startsWith("{")) {
    try {
      return JSON.parse(payload);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function postIngestWithFallback(workspaceId, body, idempotencyKey) {
  const bcCtx = await getBusinessCentralIntegration(workspaceId);
  if (!bcCtx?.baseUrl) {
    if (!env.bcErpUseMock) {
      const err = new Error("Integración Business Central sin baseUrl (configurá workspace integration business_central)");
      throw err;
    }
    return {
      mock: true,
      json: {
        accepted: true,
        externalRefs: [`MOCK-${idempotencyKey.slice(0, 8)}`],
        warnings: ["BC_ERP_USE_MOCK: sin llamada HTTP a Business Central"],
      },
    };
  }

  const bearer = await resolveBcBearerToken(bcCtx);
  if (!bearer) {
    if (!env.bcErpUseMock) {
      const err = new Error(
        "Integración BC sin credenciales: inquilino y entorno en la integración, variables BC_CONNECTOR_* en el servicio, o token en opciones avanzadas",
      );
      throw err;
    }
    return {
      mock: true,
      json: {
        accepted: true,
        externalRefs: [`MOCK-${idempotencyKey.slice(0, 8)}`],
        warnings: ["BC_ERP_USE_MOCK: sin llamada HTTP a Business Central"],
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.bcErpTimeoutMs);
  try {
    const result = await bcErpPostIngest(workspaceId, body, {
      idempotencyKey,
      signal: controller.signal,
    });
    if (!result.ok) {
      const j = result.json && typeof result.json === "object" ? /** @type {Record<string, unknown>} */ (result.json) : {};
      const msg = j.message || j.error || `BC HTTP ${result.status}`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = result.status;
      throw err;
    }
    return { mock: false, json: normalizeBcIngestResponse(result.json) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Procesa un único `BcSyncEvent`: lock atómico `PENDING`→`SENT`, POST ingest BC,
 * auditoría y DLQ Kafka en fallo terminal. Reintentos transitorios vuelven a
 * `PENDING` y, si Kafka está activo, se re-publica el job.
 *
 * @param {string} workspaceId
 * @param {string} eventId
 * @returns {Promise<Record<string, unknown>>}
 */
async function processBcSyncEventById(workspaceId, eventId) {
  const { createAuditEvent } = require("./audit.service");
  const { AUDIT_ACTION } = require("../constants/audit-actions");
  const { isKafkaEnabled, publishBcSyncJob, publishBcSyncDlq } = require("../lib/kafka");

  const claim = await prisma.bcSyncEvent.updateMany({
    where: { id: eventId, workspaceId, status: "PENDING" },
    data: { status: "SENT", attempt: { increment: 1 } },
  });

  if (claim.count === 0) {
    const current = await prisma.bcSyncEvent.findFirst({
      where: { id: eventId, workspaceId },
      select: { status: true },
    });
    if (!current) return { status: "NOT_FOUND" };
    if (current.status === "SYNCED") return { status: "ALREADY_SYNCED" };
    if (current.status === "FAILED") return { status: "ALREADY_FAILED" };
    return { status: "SKIP_NOT_PENDING", detail: current.status };
  }

  const ev = await prisma.bcSyncEvent.findFirst({
    where: { id: eventId, workspaceId },
    include: { mappingProfile: { include: { bcTarget: true } }, document: true },
  });
  if (!ev) return { status: "NOT_FOUND_AFTER_CLAIM" };

  try {
    const reqBody = ev.requestJson && typeof ev.requestJson === "object" ? ev.requestJson : {};
    const operations = Array.isArray(reqBody.operations) ? reqBody.operations : [];
    const payload = {
      documentId: ev.documentId,
      idempotencyKey: ev.id,
      operations,
    };

    const out = await postIngestWithFallback(workspaceId, payload, ev.id);
    const json = out.json;
    const externalRefs = Array.isArray(json.externalRefs) ? json.externalRefs : [];
    const externalRef = externalRefs[0] || json.externalRef || null;

    await prisma.$transaction(async (tx) => {
      await tx.bcSyncEvent.update({
        where: { id: ev.id },
        data: {
          status: "SYNCED",
          responseJson: { ...json, _mock: out.mock },
          externalRef,
          lastError: null,
        },
      });
      if (ev.documentId) {
        await tx.documentRecord.update({
          where: { id: ev.documentId },
          data: { status: "ERP_SYNCED", lastError: null },
        });
      }
    });

    await createAuditEvent({
      action: AUDIT_ACTION.BC_SYNC_SUCCEEDED,
      workspaceId,
      entityType: "BcSyncEvent",
      entityId: ev.id,
      metadata: {
        documentId: ev.documentId,
        externalRef,
        mockIngest: out.mock === true,
      },
    });

    return { status: "SYNCED", eventId: ev.id, externalRef };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const attemptAfterTry = ev.attempt;
    const retry = isRetryable(err) && attemptAfterTry < 6;
    const retryDelayMs = Math.min(30 * 60 * 1000, attemptAfterTry * attemptAfterTry * 10000);
    const holdUntil = new Date(Date.now() + retryDelayMs);

    await prisma.bcSyncEvent.update({
      where: { id: ev.id },
      data: {
        status: retry ? "PENDING" : "FAILED",
        lastError: msg.slice(0, 4000),
        responseJson: retry
          ? { retryNotBefore: holdUntil.toISOString() }
          : { finalErrorAt: new Date().toISOString() },
      },
    });

    const shortErr = msg.slice(0, 500);

    if (retry) {
      await createAuditEvent({
        action: AUDIT_ACTION.BC_SYNC_RETRY_SCHEDULED,
        workspaceId,
        entityType: "BcSyncEvent",
        entityId: ev.id,
        metadata: {
          documentId: ev.documentId,
          attempt: attemptAfterTry,
          retryNotBefore: holdUntil.toISOString(),
          error: shortErr,
        },
      });
      if (isKafkaEnabled()) {
        const republished = await publishBcSyncJob({
          eventId: ev.id,
          workspaceId,
          documentId: ev.documentId ?? undefined,
          mappingProfileId: ev.mappingProfileId ?? undefined,
        });
        if (!republished) {
          logger.warn(
            { component: "bc-sync", eventId: ev.id, workspaceId },
            "reintento BC: no se pudo re-publicar en Kafka; usar POST /bc/sync-events/process o revisar broker",
          );
        }
      }
      return { status: "RETRY", eventId: ev.id };
    }

    if (ev.documentId) {
      await prisma.documentRecord.update({
        where: { id: ev.documentId },
        data: { status: "FAILED", lastError: `BC sync failed: ${shortErr}` },
      });
    }

    await createAuditEvent({
      action: AUDIT_ACTION.BC_SYNC_FAILED,
      workspaceId,
      entityType: "BcSyncEvent",
      entityId: ev.id,
      metadata: {
        documentId: ev.documentId,
        attempt: attemptAfterTry,
        error: msg.slice(0, 2000),
      },
    });

    if (isKafkaEnabled()) {
      await publishBcSyncDlq({
        eventId: ev.id,
        workspaceId,
        documentId: ev.documentId,
        mappingProfileId: ev.mappingProfileId,
        reason: "bc_sync_terminal_failure",
        error: msg.slice(0, 4000),
        failedAt: new Date().toISOString(),
      });
    }

    return { status: "FAILED", eventId: ev.id, error: shortErr };
  }
}

async function processPendingBcSync(workspaceId, limit = 30) {
  const events = await prisma.bcSyncEvent.findMany({
    where: { workspaceId, status: "PENDING" },
    take: Math.min(100, Math.max(1, limit)),
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const results = [];
  for (const row of events) {
    const r = await processBcSyncEventById(workspaceId, row.id);
    results.push({ eventId: row.id, ...r });
  }

  return { processed: results.length, results };
}

async function listBcSyncEvents(workspaceId, status) {
  return prisma.bcSyncEvent.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      document: { select: { id: true, fileName: true, status: true } },
      mappingProfile: {
        select: { id: true, name: true, bcTarget: { select: { key: true, displayName: true } } },
      },
    },
  });
}

module.exports = {
  queueBcSync,
  processBcSyncEventById,
  processPendingBcSync,
  listBcSyncEvents,
};
