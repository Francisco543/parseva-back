/**
 * @file Configuración de automatización del workspace
 * (SharePoint integration por defecto, plantilla de ruta, modelo OpenAI, flags).
 * @module services/workspace-automation
 */

const { z } = require("zod");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { INTEGRATION_KIND, INTEGRATION_STATUS } = require("../constants/integration");

/**
 * @typedef {object} AutomationSettings
 * @property {string|null} sharepointIntegrationId
 * @property {string} pathTemplate
 * @property {string} rootFolder
 * @property {boolean} extractionEnabled
 * @property {string} openaiModel
 */

const automationSchema = z.object({
  sharepointIntegrationId: z.string().min(1).nullable().optional(),
  pathTemplate: z.string().max(500).optional().default("/{year}/{month}/{vendor_slug}"),
  rootFolder: z.string().max(200).optional().default(""),
  extractionEnabled: z.boolean().optional().default(true),
  openaiModel: z.string().max(80).optional().default("gpt-4o-mini"),
});

/** @type {AutomationSettings} */
const defaultSettings = {
  sharepointIntegrationId: null,
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
  return { ...defaultSettings, ...value };
}

/**
 * Resuelve una integración SharePoint por defecto para el workspace cuando
 * todavía no hay `sharepointIntegrationId` configurado explícitamente.
 *
 * Reglas:
 *  - Solo toma integraciones `CONNECTED`.
 *  - Prioriza una integración con `driveId` configurado.
 *  - Si no hay ninguna válida, devuelve `null`.
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

  const settings = coerceSettings(workspace.automationSettings);
  if (settings.sharepointIntegrationId) return settings;

  const fallbackSharePointId = await resolveDefaultSharepointIntegrationId(workspaceId);
  if (!fallbackSharePointId) return settings;

  // Autocompleta y persiste para evitar que futuros jobs queden sin archivado.
  const next = { ...settings, sharepointIntegrationId: fallbackSharePointId };
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
 * @throws {HttpError} 400 si el payload es inválido o el SharePoint integration no pertenece al workspace.
 * @throws {HttpError} 404 si el workspace no existe.
 */
async function updateAutomationSettings(workspaceId, payload) {
  const parsed = automationSchema.safeParse(payload || {});
  if (!parsed.success) {
    throw new HttpError(400, "Configuracion de automatizacion invalida");
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const current = coerceSettings(workspace.automationSettings);
  const next = { ...current, ...parsed.data };

  if (next.sharepointIntegrationId) {
    const sp = await prisma.integrationConnection.findFirst({
      where: {
        id: next.sharepointIntegrationId,
        workspaceId,
        kind: INTEGRATION_KIND.SHAREPOINT,
      },
    });
    if (!sp) {
      throw new HttpError(400, "Integracion SharePoint no encontrada en este workspace");
    }
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { automationSettings: next },
  });

  return next;
}

module.exports = {
  getAutomationSettings,
  updateAutomationSettings,
  coerceSettings,
  defaultSettings,
};
