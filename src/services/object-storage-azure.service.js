/**
 * Subida/descarga en Azure Blob Storage.
 * configJson: { containerName, connectionString } o { accountName, accountKey, containerName }
 *
 * @module services/object-storage-azure
 */

const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const HttpError = require("../utils/http-error");

/**
 * @param {Record<string, unknown>} cfg
 */
function buildContainerClient(cfg) {
  const containerName =
    typeof cfg.containerName === "string" ? cfg.containerName.trim() : "";
  if (!containerName) throw new HttpError(400, "Azure Blob: falta containerName");

  const connectionString =
    typeof cfg.connectionString === "string" && cfg.connectionString.trim()
      ? cfg.connectionString.trim()
      : null;

  if (connectionString) {
    const svc = BlobServiceClient.fromConnectionString(connectionString);
    return svc.getContainerClient(containerName);
  }

  const accountName =
    typeof cfg.accountName === "string" ? cfg.accountName.trim() : "";
  const accountKey =
    typeof cfg.accountKey === "string" ? cfg.accountKey.trim() : "";
  if (!accountName || !accountKey) {
    throw new HttpError(
      400,
      "Azure Blob: indicá connectionString o accountName + accountKey en la integración"
    );
  }

  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const svc = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  return svc.getContainerClient(containerName);
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} blobPath path relativo sin leading slash
 * @param {Buffer} buffer
 * @param {string} [contentType]
 */
async function putAzureBlob(cfg, blobPath, buffer, contentType) {
  const prefix =
    typeof cfg.blobPrefix === "string" ? cfg.blobPrefix.replace(/^\/+|\/+$/g, "").trim() : "";
  const name = prefix ? `${prefix}/${blobPath.replace(/^\/+/, "")}` : blobPath.replace(/^\/+/, "");

  const container = buildContainerClient(cfg);
  const blockBlobClient = container.getBlockBlobClient(name);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" },
  });

  return {
    containerName:
      typeof cfg.containerName === "string" ? cfg.containerName.trim() : "",
    blobName: name,
    url: blockBlobClient.url,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} blobName full blob path as stored (sharepointItemId)
 */
async function getAzureBlobBuffer(cfg, blobName) {
  const container = buildContainerClient(cfg);
  const client = container.getBlobClient(blobName);
  const props = await client.download();
  const chunks = [];
  for await (const chunk of props.readableStreamBody) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const contentType = props.contentType || "application/octet-stream";
  return { buffer, contentType };
}

function isAzureBlobConfigReady(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  if (!cfg.containerName) return false;
  if (typeof cfg.connectionString === "string" && cfg.connectionString.trim()) return true;
  return Boolean(cfg.accountName && cfg.accountKey);
}

module.exports = {
  putAzureBlob,
  getAzureBlobBuffer,
  isAzureBlobConfigReady,
};
