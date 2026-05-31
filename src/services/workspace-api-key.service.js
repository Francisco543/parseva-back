/**
 * API keys de servicio por workspace (hash SHA-256, el valor plano solo al crear).
 *
 * @module services/workspace-api-key
 */

const crypto = require("node:crypto");

const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

function hashKey(plain) {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

async function listWorkspaceApiKeys(workspaceId) {
  return prisma.workspaceApiKey.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
    },
  });
}

/**
 * @returns {Promise<{ apiKey: { id: string, name: string, keyPrefix: string }, plainKey: string }>}
 */
async function createWorkspaceApiKey(workspaceId, input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new HttpError(400, "Nombre obligatorio");
  const plain = `pv_${crypto.randomBytes(24).toString("hex")}`;
  const keyHash = hashKey(plain);
  const keyPrefix = plain.slice(0, 10);
  const row = await prisma.workspaceApiKey.create({
    data: {
      workspaceId,
      name: name.slice(0, 120),
      keyPrefix,
      keyHash,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
    },
  });
  return { apiKey: row, plainKey: plain };
}

async function deleteWorkspaceApiKey(workspaceId, id) {
  const row = await prisma.workspaceApiKey.findFirst({ where: { id, workspaceId } });
  if (!row) throw new HttpError(404, "API key no encontrada");
  await prisma.workspaceApiKey.delete({ where: { id } });
}

/**
 * Resuelve workspaceId desde cabecera `X-Parseva-Api-Key`.
 *
 * @param {string | undefined} headerValue
 * @returns {Promise<string | null>} workspaceId
 */
async function resolveWorkspaceFromApiKey(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const h = hashKey(headerValue.trim());
  const row = await prisma.workspaceApiKey.findFirst({
    where: { keyHash: h },
    select: { workspaceId: true },
  });
  return row?.workspaceId ?? null;
}

module.exports = {
  listWorkspaceApiKeys,
  createWorkspaceApiKey,
  deleteWorkspaceApiKey,
  resolveWorkspaceFromApiKey,
  hashKey,
};
