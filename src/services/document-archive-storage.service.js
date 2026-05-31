/**
 * Archivado unificado: SharePoint (Graph), Amazon S3, Azure Blob.
 *
 * @module services/document-archive-storage
 */

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const {
  INTEGRATION_KIND,
  ARCHIVE_STORAGE_KINDS,
} = require("../constants/integration");
const { isS3ConfigReady } = require("./object-storage-s3.service");
const { isAzureBlobConfigReady } = require("./object-storage-azure.service");

/**
 * @param {import("@prisma/client").IntegrationConnection} integration
 * @returns {boolean}
 */
function isIntegrationReadyForArchive(integration) {
  if (!integration) return false;
  const cfg =
    integration.configJson && typeof integration.configJson === "object"
      ? integration.configJson
      : {};
  if (integration.kind === INTEGRATION_KIND.SHAREPOINT) return Boolean(cfg.driveId);
  if (integration.kind === INTEGRATION_KIND.S3) return isS3ConfigReady(cfg);
  if (integration.kind === INTEGRATION_KIND.AZURE_BLOB) return isAzureBlobConfigReady(cfg);
  return false;
}

/**
 * @param {string} workspaceId
 * @param {string} integrationId
 */
async function assertArchiveIntegration(workspaceId, integrationId) {
  const integ = await prisma.integrationConnection.findFirst({
    where: { id: integrationId, workspaceId },
  });
  if (!integ) throw new HttpError(400, "Integración de archivado no encontrada en este workspace");
  if (!ARCHIVE_STORAGE_KINDS.includes(integ.kind)) {
    throw new HttpError(400, "La integración no es un destino de archivado válido");
  }
  if (!isIntegrationReadyForArchive(integ)) {
    throw new HttpError(400, "La integración de archivado no está configurada por completo");
  }
  return integ;
}

/**
 * @param {object} params
 * @param {string | null | undefined} params.tenantId Azure AD tenant (SharePoint).
 * @param {import("@prisma/client").IntegrationConnection} params.integration
 * @param {string} params.integrationId
 * @param {string} params.relativePath
 * @param {Buffer} params.buffer
 * @param {string} [params.contentType]
 * @returns {Promise<Record<string, unknown>>} datos para `documentRecord.update`
 */
async function archiveUploadFromIntegration(params) {
  const {
    tenantId,
    integration,
    integrationId,
    relativePath,
    buffer,
    contentType,
  } = params;
  const kind = integration.kind;
  const cfg =
    integration.configJson && typeof integration.configJson === "object"
      ? integration.configJson
      : {};

  if (kind === INTEGRATION_KIND.SHAREPOINT) {
    const { uploadDriveItem } = require("./sharepoint.service");
    if (!cfg.driveId) {
      throw new HttpError(409, "La integración SharePoint no tiene driveId configurado.");
    }
    if (!tenantId) throw new HttpError(500, "Workspace sin tenant de Azure AD");
    const uploaded = await uploadDriveItem(
      tenantId,
      cfg.driveId,
      relativePath,
      buffer,
      contentType
    );
    return {
      status: "ARCHIVED",
      archiveIntegrationId: integrationId,
      archiveStorageKind: "sharepoint",
      archiveStorageExtra: null,
      sharepointSiteId: cfg.siteId || null,
      sharepointDriveId: cfg.driveId,
      sharepointItemId: uploaded?.id || null,
      sharepointWebUrl: uploaded?.webUrl || null,
      sharepointPath: relativePath,
      lastError: null,
    };
  }

  if (kind === INTEGRATION_KIND.S3) {
    const { putS3Object } = require("./object-storage-s3.service");
    const out = await putS3Object(cfg, relativePath, buffer, contentType);
    return {
      status: "ARCHIVED",
      archiveIntegrationId: integrationId,
      archiveStorageKind: "s3",
      archiveStorageExtra: { etag: out.etag || null, region: out.region },
      sharepointSiteId: null,
      sharepointDriveId: out.bucket,
      sharepointItemId: out.key,
      sharepointWebUrl: out.publicUrl,
      sharepointPath: relativePath,
      lastError: null,
    };
  }

  if (kind === INTEGRATION_KIND.AZURE_BLOB) {
    const { putAzureBlob } = require("./object-storage-azure.service");
    const out = await putAzureBlob(cfg, relativePath, buffer, contentType);
    return {
      status: "ARCHIVED",
      archiveIntegrationId: integrationId,
      archiveStorageKind: "azure_blob",
      archiveStorageExtra: null,
      sharepointSiteId: null,
      sharepointDriveId: out.containerName,
      sharepointItemId: out.blobName,
      sharepointWebUrl: out.url,
      sharepointPath: relativePath,
      lastError: null,
    };
  }

  throw new HttpError(400, `Tipo de integración no soportado para archivado: ${kind}`);
}

/**
 * Descarga bytes desde el destino donde quedó archivado el documento.
 *
 * @param {import("@prisma/client").DocumentRecord} doc
 * @param {{ aadTenantId: string|null }} workspace
 */
async function downloadArchivedDocumentBuffer(doc, workspace) {
  const wsId = doc.workspaceId;
  if (!wsId) throw new HttpError(500, "Documento sin workspace");

  const kind =
    doc.archiveStorageKind ||
    (doc.sharepointDriveId && doc.sharepointItemId ? "sharepoint" : null);

  if (!kind || kind === "sharepoint") {
    const { graphGetBuffer } = require("../lib/graph-client");
    if (!doc.sharepointDriveId || !doc.sharepointItemId) {
      throw new HttpError(
        404,
        "El archivo aún no está disponible (falta referencia de almacenamiento)."
      );
    }
    const tenantId = workspace?.aadTenantId;
    if (!tenantId) throw new HttpError(500, "Workspace sin tenant de Azure AD");
    const path = `/drives/${encodeURIComponent(doc.sharepointDriveId)}/items/${encodeURIComponent(
      doc.sharepointItemId
    )}/content`;
    const buffer = await graphGetBuffer(path, { tenantId });
    return {
      buffer,
      contentType: doc.contentType || "application/octet-stream",
      fileName: doc.fileName || "documento",
    };
  }

  if (!doc.archiveIntegrationId) {
    throw new HttpError(
      409,
      "Documento archivado sin referencia de integración; no se puede descargar."
    );
  }

  const integration = await prisma.integrationConnection.findFirst({
    where: { id: doc.archiveIntegrationId, workspaceId: wsId },
  });
  if (!integration) throw new HttpError(404, "Integración de archivado no encontrada");

  const cfg =
    integration.configJson && typeof integration.configJson === "object"
      ? integration.configJson
      : {};

  if (kind === "s3") {
    const { getS3ObjectBuffer } = require("./object-storage-s3.service");
    const bucket = doc.sharepointDriveId;
    const key = doc.sharepointItemId;
    if (!bucket || !key) throw new HttpError(404, "Referencias S3 incompletas");
    const { buffer, contentType } = await getS3ObjectBuffer(cfg, bucket, key);
    return {
      buffer,
      contentType: contentType || doc.contentType || "application/pdf",
      fileName: doc.fileName || "documento.pdf",
    };
  }

  if (kind === "azure_blob") {
    const { getAzureBlobBuffer } = require("./object-storage-azure.service");
    const blobName = doc.sharepointItemId;
    if (!blobName) throw new HttpError(404, "Referencia Azure incompleta");
    const { buffer, contentType } = await getAzureBlobBuffer(cfg, blobName);
    return {
      buffer,
      contentType: contentType || doc.contentType || "application/pdf",
      fileName: doc.fileName || "documento.pdf",
    };
  }

  throw new HttpError(400, `Descarga no implementada para storage kind=${kind}`);
}

module.exports = {
  archiveUploadFromIntegration,
  downloadArchivedDocumentBuffer,
  isIntegrationReadyForArchive,
  assertArchiveIntegration,
};
