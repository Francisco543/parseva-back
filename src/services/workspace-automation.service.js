/**
 * @file Configuración de automatización del workspace
 * (integración de archivado: SharePoint, S3, Azure Blob; plantilla de ruta, modelo OpenAI).
 *
 * @module services/workspace-automation
 */

const { z } = require("zod");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { INTEGRATION_KIND, INTEGRATION_STATUS } = require("../constants/integration");
const { isS3ConfigReady } = require("./object-storage-s3.service");
const { isAzureBlobConfigReady } = require("./object-storage-azure.service");
const { assertArchiveIntegration } = require("./document-archive-storage.service");

/**
 * @typedef {object} AutomationSettings
 * @property {string|null} sharepointIntegrationId Legacy; sincronizado con storage cuando es SP.
 * @property {string|null} storageIntegrationId Integración usada para archivar PDFs (SP | S3 | Azure Blob).
 * @property {string} pathTemplate
 * @property {string} rootFolder
 * @property {boolean} extractionEnabled
 * @property {string} openaiModel
 */

const automationSchema = z.object({
  sharepointIntegrationId: z.string().min(1).nullable().optional(),
  storageIntegrationId: z.string().min(1).nullable().optional(),
  pathTemplate: z.string().max(500).optional().default("/{year}/{month}/{vendor_slug}"),
  rootFolder: z.string().max(200).optional().default(""),
  extractionEnabled: z.boolean().optional().default(true),
  openaiModel: z.string().max(80).optional().default("gpt-4o-mini"),
});

/** @type {AutomationSettings} */
const defaultSettings = {
  sharepointIntegrationId: null,
  storageIntegrationId: null,
  pathTemplate: "/{year}/{month}/{vendor_slug}",
  rootFolder: "",
  extractionEnabled: true,
  openaiModel: "gpt-4o-mini",
};

/**
 * Mezcla los settings persistidos con los defaults para entregar siempre un objeto completo.
 *
 * @param {unknown} value
 * @returns {AutomationSettings}
 */
function coerceSettings(value) {
  if (!value || typeof value !== "object") return { ...defaultSettings };
  const merged = { ...defaultSettings, ...value };
  if (!merged.storageIntegrationId && merged.sharepointIntegrationId) {
    merged.storageIntegrationId = merged.sharepointIntegrationId;
  }
  return merged;
}

/**
 * Id efectivo de integración para archivar (prioriza `storageIntegrationId`).
 *
 * @param {unknown} automationSettingsRaw
 * @returns {string|null}
 */
function getArchiveIntegrationId(automationSettingsRaw) {
  const s = coerceSettings(automationSettingsRaw);
  return s.storageIntegrationId || s.sharepointIntegrationId || null;
}

/**
 * Resuelve una integración SharePoint por defecto para el workspace cuando
 * todavía no hay id configurado explícitamente.
 *
 * @param {string} workspaceId
 * @returns {Promise<string|null>}
 */
async function resolveDefaultSharepointIntegrationId(workspaceId) {
  const candidate = await prisma.integrationConnection.findFirst({
    where: {
      workspaceId,
      kind: INTEGRATION_KIND.SHAREPOINT,
      status: INTEGRATION_STATUS.CONNECTED,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!candidate) return null;
  const cfg =
    candidate.configJson && typeof candidate.configJson === "object" ? candidate.configJson : {};
  if (!cfg.driveId) return null;
  return candidate.id;
}

/**
 * Resuelve integración de archivado por defecto: SharePoint válido, luego S3, luego Azure Blob.
 *
 * @param {string} workspaceId
 * @returns {Promise<string|null>}
 */
async function resolveDefaultArchiveIntegrationId(workspaceId) {
  const sp = await resolveDefaultSharepointIntegrationId(workspaceId);
  if (sp) return sp;

  const s3rows = await prisma.integrationConnection.findMany({
    where: {
      workspaceId,
      kind: INTEGRATION_KIND.S3,
      status: INTEGRATION_STATUS.CONNECTED,
    },
    orderBy: { updatedAt: "desc" },
  });
  for (const row of s3rows) {
    const cfg = row.configJson && typeof row.configJson === "object" ? row.configJson : {};
    if (isS3ConfigReady(cfg)) return row.id;
  }

  const azRows = await prisma.integrationConnection.findMany({
    where: {
      workspaceId,
      kind: INTEGRATION_KIND.AZURE_BLOB,
      status: INTEGRATION_STATUS.CONNECTED,
    },
    orderBy: { updatedAt: "desc" },
  });
  for (const row of azRows) {
    const cfg = row.configJson && typeof row.configJson === "object" ? row.configJson : {};
    if (isAzureBlobConfigReady(cfg)) return row.id;
  }

  return null;
}

/**
 * Devuelve la configuración de automatización del workspace.
 *
 * @param {string} workspaceId
 * @returns {Promise<AutomationSettings>}
 * @throws {HttpError} 404 si el workspace no existe.
 */
async function getAutomationSettings(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, automationSettings: true },
  });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  let settings = coerceSettings(workspace.automationSettings);
  const effectiveId = settings.storageIntegrationId || settings.sharepointIntegrationId;
  if (effectiveId) return settings;

  const fallbackId = await resolveDefaultArchiveIntegrationId(workspaceId);
  if (!fallbackId) return settings;

  const integ = await prisma.integrationConnection.findFirst({
    where: { id: fallbackId, workspaceId },
  });

  const next = {
    ...settings,
    storageIntegrationId: fallbackId,
  };
  if (integ?.kind === INTEGRATION_KIND.SHAREPOINT) {
    next.sharepointIntegrationId = fallbackId;
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { automationSettings: next },
  });

  return next;
}

/**
 * Actualiza (parcialmente) la configuración de automatización del workspace.
 *
 * @param {string} workspaceId
 * @param {Partial<AutomationSettings>} payload
 * @returns {Promise<AutomationSettings>}
 */
async function updateAutomationSettings(workspaceId, payload) {
  const parsed = automationSchema.safeParse(payload || {});
  if (!parsed.success) {
    throw new HttpError(400, "Configuracion de automatizacion invalida");
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const current = coerceSettings(workspace.automationSettings);
  /** @type {Record<string, unknown>} */
  const next = { ...current, ...parsed.data };

  if (
    parsed.data.sharepointIntegrationId !== undefined &&
    parsed.data.storageIntegrationId === undefined
  ) {
    next.storageIntegrationId = parsed.data.sharepointIntegrationId ?? next.storageIntegrationId;
  }

  const archiveId = next.storageIntegrationId || next.sharepointIntegrationId;
  if (archiveId) {
    await assertArchiveIntegration(workspaceId, archiveId);
    const integ = await prisma.integrationConnection.findFirst({
      where: { id: archiveId, workspaceId },
    });
    if (integ?.kind === INTEGRATION_KIND.SHAREPOINT) {
      next.sharepointIntegrationId = archiveId;
    }
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { automationSettings: next },
  });

  return coerceSettings(next);
}

module.exports = {
  getAutomationSettings,
  updateAutomationSettings,
  coerceSettings,
  defaultSettings,
  getArchiveIntegrationId,
  resolveDefaultArchiveIntegrationId,
};
