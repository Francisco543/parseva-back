const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const env = require("../config/env");
const { policiesPatchSchema } = require("./document-type-policies");
const { suggestAiExtractionSchema } = require("./document-extraction.service");
const { validateSharePointPathTemplate } = require("./sharepoint-path-template");

const createSchema = z.object({
  key: z.string().trim().min(2).max(40),
  displayName: z.string().trim().min(2).max(120),
  enabled: z.boolean().optional().default(true),
  sharePointPathTemplate: z.string().trim().max(500).nullable().optional(),
  requireApprovalBeforeErp: z.boolean().optional().default(true),
  aiExtractionSchema: z.any().optional(),
  sharepointRouting: policiesPatchSchema.shape.sharepointRouting,
  matchingPolicy: policiesPatchSchema.shape.matchingPolicy,
  approvalPolicy: policiesPatchSchema.shape.approvalPolicy,
  validationPolicy: policiesPatchSchema.shape.validationPolicy,
  bcPolicy: policiesPatchSchema.shape.bcPolicy,
  configVersion: z.number().int().min(1).optional(),
});

const patchSchema = createSchema.partial();

/** Cuerpo de POST /document-types/:id/suggest-extraction-schema */
const suggestExtractionBodySchema = z.object({
  userHint: z.string().max(2000).optional().nullable(),
  baseSchema: z.any().optional().nullable(),
});

async function listDocumentTypes(workspaceId) {
  return prisma.documentType.findMany({
    where: { workspaceId },
    orderBy: [{ enabled: "desc" }, { createdAt: "asc" }],
  });
}

async function createDocumentType(workspaceId, input) {
  const parsed = createSchema.safeParse(input || {});
  if (!parsed.success) throw new HttpError(400, "Invalid document type payload");
  const d = parsed.data;
  const pathCheck = validateSharePointPathTemplate(d.sharePointPathTemplate, d.aiExtractionSchema);
  if (!pathCheck.ok) {
    throw new HttpError(
      400,
      `Plantilla de ruta SharePoint: tokens no permitidos {${pathCheck.invalidTokens.join("}, {")}}. ` +
        "Usá solo fechas/tipo de documento o keys del esquema de extracción, o tokens legacy de factura."
    );
  }
  return prisma.documentType.create({
    data: {
      workspaceId,
      key: d.key,
      displayName: d.displayName,
      enabled: d.enabled,
      sharePointPathTemplate: d.sharePointPathTemplate ?? null,
      requireApprovalBeforeErp: d.requireApprovalBeforeErp,
      aiExtractionSchema: d.aiExtractionSchema ?? null,
      sharepointRouting: d.sharepointRouting ?? undefined,
      matchingPolicy: d.matchingPolicy ?? undefined,
      approvalPolicy: d.approvalPolicy ?? undefined,
      validationPolicy: d.validationPolicy ?? undefined,
      bcPolicy: d.bcPolicy ?? undefined,
      configVersion: d.configVersion ?? 1,
    },
  });
}

async function patchDocumentType(workspaceId, id, input) {
  const existing = await prisma.documentType.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "Document type not found");
  const parsed = patchSchema.safeParse(input || {});
  if (!parsed.success) throw new HttpError(400, "Invalid document type payload");

  const data = { ...parsed.data };
  if (data.sharePointPathTemplate === undefined) delete data.sharePointPathTemplate;

  const templateToCheck =
    data.sharePointPathTemplate !== undefined
      ? data.sharePointPathTemplate
      : existing.sharePointPathTemplate;
  const schemaForCheck =
    data.aiExtractionSchema !== undefined ? data.aiExtractionSchema : existing.aiExtractionSchema;
  const pathCheck = validateSharePointPathTemplate(templateToCheck, schemaForCheck);
  if (!pathCheck.ok) {
    throw new HttpError(
      400,
      `Plantilla de ruta SharePoint: tokens no permitidos {${pathCheck.invalidTokens.join("}, {")}}. ` +
        "Usá solo fechas/tipo de documento o keys definidas en Campos a extraer (JSON), " +
        "o tokens legacy de factura (vendor_slug, invoice_number, etc.)."
    );
  }

  return prisma.documentType.update({
    where: { id },
    data,
  });
}

async function suggestDocumentTypeExtractionSchema(workspaceId, documentTypeId, body) {
  const existing = await prisma.documentType.findFirst({
    where: { id: documentTypeId, workspaceId },
  });
  if (!existing) throw new HttpError(404, "Document type not found");

  const parsed = suggestExtractionBodySchema.safeParse(body || {});
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const hint = Object.entries(issues)
      .map(([k, v]) => `${k}: ${(v || []).join(", ")}`)
      .join("; ");
    throw new HttpError(
      400,
      hint
        ? `Datos invalidos en la solicitud (${hint}). Revisa userHint (max. 2000 caracteres) y baseSchema (JSON opcional).`
        : "Datos invalidos en la solicitud de sugerencia. Revisa el cuerpo JSON enviado."
    );
  }

  const sp =
    existing.sharepointRouting && typeof existing.sharepointRouting === "object"
      ? existing.sharepointRouting
      : {};
  const classifierHint =
    typeof sp.description === "string" && sp.description.trim()
      ? sp.description.trim().slice(0, 800)
      : null;

  try {
    const aiExtractionSchema = await suggestAiExtractionSchema(
      {
        key: existing.key,
        displayName: existing.displayName,
        classifierHint,
        userHint: parsed.data.userHint || null,
        baseSchema: parsed.data.baseSchema === undefined ? null : parsed.data.baseSchema,
      },
      { model: env.openaiModel }
    );
    return { aiExtractionSchema };
  } catch (err) {
    if (err && err.code === "OPENAI_NOT_CONFIGURED") {
      throw new HttpError(
        503,
        "La sugerencia con IA no esta disponible: falta configurar la API de OpenAI en el servidor (variable de entorno)."
      );
    }
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      "No pudimos generar la sugerencia en este momento. Intenta de nuevo en unos segundos; si el problema sigue, revisa la conexion con OpenAI."
    );
  }
}

module.exports = {
  listDocumentTypes,
  createDocumentType,
  patchDocumentType,
  suggestDocumentTypeExtractionSchema,
};
