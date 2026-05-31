/**
 * Subida/descarga de objetos en Amazon S3.
 * configJson: { bucket, region, accessKeyId?, secretAccessKey?, keyPrefix? }
 * Si no hay accessKeyId/secretAccessKey se intenta la cadena por defecto del SDK (env/instance profile).
 *
 * @module services/object-storage-s3
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const HttpError = require("../utils/http-error");

/**
 * @param {Record<string, unknown>} cfg
 */
function buildClient(cfg) {
  const region = typeof cfg.region === "string" ? cfg.region.trim() : "";
  if (!region) throw new HttpError(400, "S3: falta region en la integración");

  const accessKeyId =
    typeof cfg.accessKeyId === "string" && cfg.accessKeyId.trim()
      ? cfg.accessKeyId.trim()
      : undefined;
  const secretAccessKey =
    typeof cfg.secretAccessKey === "string" && cfg.secretAccessKey.trim()
      ? cfg.secretAccessKey.trim()
      : undefined;

  return new S3Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} relativePath
 * @param {Buffer} buffer
 * @param {string} [contentType]
 */
async function putS3Object(cfg, relativePath, buffer, contentType) {
  const bucket = typeof cfg.bucket === "string" ? cfg.bucket.trim() : "";
  if (!bucket) throw new HttpError(400, "S3: falta bucket en la integración");

  const prefix =
    typeof cfg.keyPrefix === "string" ? cfg.keyPrefix.replace(/^\/+|\/+$/g, "").trim() : "";
  const key = prefix ? `${prefix}/${relativePath.replace(/^\/+/, "")}` : relativePath.replace(/^\/+/, "");

  const client = buildClient(cfg);
  const out = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );

  const publicBase =
    typeof cfg.publicBaseUrl === "string" ? cfg.publicBaseUrl.replace(/\/+$/, "").trim() : "";
  const publicUrl = publicBase ? `${publicBase}/${encodeURI(key)}` : null;

  return {
    bucket,
    key,
    region: typeof cfg.region === "string" ? cfg.region.trim() : "",
    etag: out.ETag ? String(out.ETag).replace(/"/g, "") : null,
    publicUrl,
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function getS3ObjectBuffer(cfg, bucket, key) {
  const client = buildClient(cfg);
  const out = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  const chunks = [];
  for await (const chunk of out.Body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const contentType = out.ContentType || "application/octet-stream";
  return { buffer, contentType };
}

function isS3ConfigReady(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  return Boolean(cfg.bucket && cfg.region);
}

module.exports = {
  putS3Object,
  getS3ObjectBuffer,
  isS3ConfigReady,
};
