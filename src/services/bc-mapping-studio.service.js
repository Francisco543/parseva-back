const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { normalizeBcTargetsPayload } = require("../utils/bc-erp-targets-normalize");
const { extractBcApiErrorMessage } = require("../utils/bc-erp-api-error-message");
const { bcErpFetch } = require("./bc-erp-client.service");

const targetSchema = z.object({
  key: z.string().min(2).max(80),
  displayName: z.string().min(2).max(120),
  category: z.string().max(80).optional().nullable(),
  mode: z.enum(["CURATED", "EXTENSION"]).optional().default("CURATED"),
  enabled: z.boolean().optional().default(true),
  schemaJson: z.any().optional(),
});

const fieldSchema = z.object({
  bcTargetId: z.string().min(1),
  key: z.string().min(1).max(80),
  displayName: z.string().min(1).max(120),
  dataType: z.string().min(1).max(40),
  required: z.boolean().optional().default(false),
  allowWrite: z.boolean().optional().default(true),
  uiHint: z.string().max(40).optional().nullable(),
  lookupRef: z.string().max(80).optional().nullable(),
});

const profileSchema = z.object({
  documentTypeId: z.string().min(1),
  bcTargetId: z.string().min(1),
  name: z.string().min(2).max(120),
  enabled: z.boolean().optional().default(true),
  syncOrder: z.coerce.number().int().min(0).max(9999).optional().default(0),
  fieldMap: z.any(),
  transformMap: z.any().optional().nullable(),
});

async function seedCuratedTargets(workspaceId) {
  const curated = [
    { key: "purchaseOrder", displayName: "Purchase Order", category: "purchase", mode: "CURATED" },
    { key: "purchaseInvoice", displayName: "Purchase Invoice", category: "purchase", mode: "CURATED" },
    { key: "purchaseCreditMemo", displayName: "Purchase Credit Memo", category: "purchase", mode: "CURATED" },
    { key: "salesInvoice", displayName: "Sales Invoice", category: "sales", mode: "CURATED" },
  ];
  for (const item of curated) {
    await prisma.bcTarget.upsert({
      where: { workspaceId_key: { workspaceId, key: item.key } },
      create: { workspaceId, ...item, enabled: true, schemaJson: null },
      update: { displayName: item.displayName, category: item.category, enabled: true },
    });
  }
}

async function listBcTargets(workspaceId) {
  await seedCuratedTargets(workspaceId);
  return prisma.bcTarget.findMany({
    where: { workspaceId },
    orderBy: [{ mode: "asc" }, { key: "asc" }],
    include: { fields: true, extensionConfig: true },
  });
}

async function upsertBcTarget(workspaceId, id, payload) {
  const parsed = targetSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC target payload");
  if (!id) {
    return prisma.bcTarget.create({ data: { workspaceId, ...parsed.data } });
  }
  const existing = await prisma.bcTarget.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC target not found");
  return prisma.bcTarget.update({ where: { id }, data: parsed.data });
}

async function upsertBcField(workspaceId, id, payload) {
  const parsed = fieldSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC field payload");
  const data = parsed.data;
  const target = await prisma.bcTarget.findFirst({ where: { id: data.bcTargetId, workspaceId } });
  if (!target) throw new HttpError(404, "BC target not found");
  if (!id) {
    return prisma.bcField.create({ data: { workspaceId, ...data } });
  }
  const existing = await prisma.bcField.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC field not found");
  return prisma.bcField.update({ where: { id }, data });
}

async function listMappingProfiles(workspaceId) {
  return prisma.bcMappingProfile.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      documentType: { select: { id: true, key: true, displayName: true } },
      bcTarget: { select: { id: true, key: true, displayName: true, mode: true } },
    },
  });
}

async function upsertMappingProfile(workspaceId, id, payload) {
  const parsed = profileSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid BC mapping profile payload");
  const data = parsed.data;
  if (!id) {
    return prisma.bcMappingProfile.create({ data: { workspaceId, ...data } });
  }
  const existing = await prisma.bcMappingProfile.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "BC mapping profile not found");
  return prisma.bcMappingProfile.update({ where: { id }, data });
}

/**
 * Importa metadatos de un destino desde la extensión BC (`Parseva Target`) al workspace:
 * upsert `BcTarget` + reemplaza `BcField` para validación de ingest.
 *
 * @param {string} workspaceId
 * @param {string} targetKey key OData (`targetKey` en BC)
 */
async function importErpTargetIntoWorkspace(workspaceId, targetKey) {
  const key = String(targetKey ?? "").trim();
  if (!key) throw new HttpError(400, "targetKey es obligatorio");

  let r;
  try {
    r = await bcErpFetch(workspaceId, "/targets", { method: "GET" });
  } catch (err) {
    if (err && err.code === "BC_NOT_CONFIGURED") {
      throw new HttpError(503, "Integración Business Central sin configurar o incompleta");
    }
    throw err;
  }

  const text = await r.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!r.ok) {
    const msg = extractBcApiErrorMessage(json, text, r.status);
    throw new HttpError(r.status, msg);
  }

  const { targets } = normalizeBcTargetsPayload(json);
  const t = targets.find((x) => String(x.targetKey) === key);
  if (!t) {
    throw new HttpError(404, `No existe el destino "${key}" en la extensión BC`);
  }

  await prisma.bcTarget.upsert({
    where: { workspaceId_key: { workspaceId, key: t.targetKey } },
    create: {
      workspaceId,
      key: t.targetKey,
      displayName: (t.displayName || t.targetKey).slice(0, 120),
      category: t.category ? String(t.category).slice(0, 80) : null,
      mode: "EXTENSION",
      enabled: true,
      schemaJson: null,
    },
    update: {
      displayName: (t.displayName || t.targetKey).slice(0, 120),
      category: t.category ? String(t.category).slice(0, 80) : null,
      enabled: true,
    },
  });

  const targetRow = await prisma.bcTarget.findFirst({
    where: { workspaceId, key: t.targetKey },
  });
  if (!targetRow) throw new HttpError(500, "No se pudo recargar el destino BC");

  await prisma.bcField.deleteMany({ where: { workspaceId, bcTargetId: targetRow.id } });

  const rawFields = Array.isArray(t.fields) ? t.fields : [];
  for (const f of rawFields) {
    if (!f || typeof f !== "object") continue;
    const fk = String(/** @type {{ key?: unknown }} */ (f).key ?? "").trim();
    if (!fk) continue;
    const label = String(/** @type {{ label?: unknown }} */ (f).label ?? fk).slice(0, 120);
    await prisma.bcField.create({
      data: {
        workspaceId,
        bcTargetId: targetRow.id,
        key: fk.slice(0, 80),
        displayName: label,
        dataType: String(/** @type {{ dataType?: unknown }} */ (f).dataType ?? "text").slice(0, 40),
        required: /** @type {{ required?: unknown }} */ (f).required === true,
        allowWrite: true,
        uiHint:
          /** @type {{ uiHint?: unknown }} */ (f).uiHint != null
            ? String(/** @type {{ uiHint?: unknown }} */ (f).uiHint).slice(0, 40)
            : null,
        lookupRef:
          /** @type {{ lookupRef?: unknown }} */ (f).lookupRef != null
            ? String(/** @type {{ lookupRef?: unknown }} */ (f).lookupRef).slice(0, 80)
            : null,
      },
    });
  }

  /**
   * Sin fila APPROVED, `queueBcSync` falla para destinos EXTENSION.
   * Importar desde el catálogo del propio BC es la acción de confianza del workspace.
   */
  await prisma.bcExtensionTarget.upsert({
    where: { bcTargetId: targetRow.id },
    create: {
      workspaceId,
      bcTargetId: targetRow.id,
      approvalStatus: "APPROVED",
      sourceSchema: null,
      reviewerUserId: null,
      reviewNote: "Aprobado al importar metadatos desde Business Central",
    },
    update: {
      approvalStatus: "APPROVED",
      reviewNote: "Aprobado al reimportar metadatos desde Business Central",
    },
  });

  return prisma.bcTarget.findFirst({
    where: { id: targetRow.id },
    include: { fields: true, extensionConfig: true },
  });
}

async function upsertExtensionTarget(workspaceId, bcTargetId, payload) {
  const target = await prisma.bcTarget.findFirst({ where: { id: bcTargetId, workspaceId } });
  if (!target) throw new HttpError(404, "BC target not found");
  return prisma.bcExtensionTarget.upsert({
    where: { bcTargetId },
    create: {
      workspaceId,
      bcTargetId,
      approvalStatus: payload.approvalStatus || "PENDING",
      sourceSchema: payload.sourceSchema || null,
      reviewerUserId: payload.reviewerUserId || null,
      reviewNote: payload.reviewNote || null,
    },
    update: {
      approvalStatus: payload.approvalStatus,
      sourceSchema: payload.sourceSchema,
      reviewerUserId: payload.reviewerUserId,
      reviewNote: payload.reviewNote,
    },
  });
}

module.exports = {
  listBcTargets,
  upsertBcTarget,
  upsertBcField,
  listMappingProfiles,
  upsertMappingProfile,
  upsertExtensionTarget,
  importErpTargetIntoWorkspace,
};

