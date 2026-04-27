const crypto = require("crypto");
const OpenAI = require("openai");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { logger } = require("../lib/logger");

/** Dimensión fija acordada con migration.sql / schema (vector(1536)). */
const SCHEMA_VECTOR_DIMS = 1536;

let pgvectorExtensionAvailable = null;

/**
 * @returns {Promise<boolean>}
 */
async function isPgVectorAvailable() {
  if (pgvectorExtensionAvailable !== null) return pgvectorExtensionAvailable;
  try {
    const rows = await prisma.$queryRaw`
      SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector' LIMIT 1
    `;
    pgvectorExtensionAvailable = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    logger.warn({ err: String(err.message) }, "document_embedding.pgvector_check_failed");
    pgvectorExtensionAvailable = false;
  }
  return pgvectorExtensionAvailable;
}

function getOpenAIClient() {
  if (!env.openaiApiKey) return null;
  return new OpenAI({ apiKey: env.openaiApiKey });
}

/**
 * Ordena keys de objetos anidados para texto canónico estable.
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== "object") return value;
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = sortKeysDeep(value[k]);
  }
  return out;
}

/**
 * Construye texto para embedding: metadatos + extracción sin bloque classification (ruido).
 * @param {{ fileName?: string | null; extractionJson?: unknown; documentType?: { key?: string } | null }} doc
 * @returns {string}
 */
function buildCanonicalMatchText(doc) {
  const ext =
    doc.extractionJson && typeof doc.extractionJson === "object" && !Array.isArray(doc.extractionJson)
      ? doc.extractionJson
      : {};
  const { classification: _c, ...rest } = ext;
  const typeKey = doc.documentType?.key || "";
  const lines = [
    `file:${String(doc.fileName || "")}`,
    `type:${typeKey}`,
    `data:${JSON.stringify(sortKeysDeep(rest))}`,
  ];
  let text = lines.join("\n");
  const max = env.embeddingMaxChars;
  if (text.length > max) text = text.slice(0, max);
  return text;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * SQL para literal vector en parámetros raw (solo floats).
 * @param {number[]} embedding
 * @returns {import("@prisma/client").Prisma.Sql}
 */
function vectorLiteral(embedding) {
  const safe = embedding.map((n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) throw new Error("Invalid embedding value");
    return x;
  });
  return Prisma.raw(`'[${safe.join(",")}]'::vector`);
}

/**
 * Garantiza fila en DocumentEmbedding para el documento si cambió el contenido o el modelo.
 * @param {string} workspaceId
 * @param {string} documentId
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, error?: string }>}
 */
async function ensureDocumentEmbedded(workspaceId, documentId) {
  if (!(await isPgVectorAvailable())) {
    return { ok: false, reason: "semantic_unavailable", error: "pgvector extension missing" };
  }

  if (env.openaiEmbeddingDims !== SCHEMA_VECTOR_DIMS) {
    logger.warn(
      { dims: env.openaiEmbeddingDims, schema: SCHEMA_VECTOR_DIMS },
      "document_embedding.dims_mismatch_schema"
    );
    return { ok: false, reason: "semantic_unavailable", error: "OPENAI_EMBEDDING_DIMS must match DB vector size" };
  }

  const client = getOpenAIClient();
  if (!client) {
    return { ok: false, reason: "semantic_unavailable", error: "OpenAI not configured" };
  }

  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    include: { documentType: { select: { key: true } } },
  });
  if (!doc) return { ok: false, reason: "not_found" };

  const canonical = buildCanonicalMatchText(doc);
  const contentHash = sha256Hex(canonical);
  const modelName = env.openaiEmbeddingModel;

  const existing = await prisma.documentEmbedding.findUnique({
    where: { documentId },
    select: { id: true, contentHash: true, model: true },
  });

  if (existing && existing.contentHash === contentHash && existing.model === modelName) {
    return { ok: true, skipped: true };
  }

  let embedding;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await client.embeddings.create({
        model: modelName,
        input: canonical,
      });
      embedding = res.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) throw new Error("empty embedding response");
      break;
    } catch (err) {
      logger.warn(
        { documentId, attempt, err: String(err.message) },
        "document_embedding.openai_retry"
      );
      if (attempt === maxAttempts) {
        return { ok: false, reason: "embed_failed", error: String(err.message) };
      }
    }
  }

  if (embedding.length !== SCHEMA_VECTOR_DIMS) {
    logger.error(
      { documentId, got: embedding.length, expected: SCHEMA_VECTOR_DIMS },
      "document_embedding.dimension_mismatch"
    );
    return { ok: false, reason: "dimension_mismatch" };
  }

  const id = existing?.id || crypto.randomUUID();
  const now = new Date();

  try {
    if (existing) {
      await prisma.$executeRaw`
        UPDATE "DocumentEmbedding"
        SET
          "model" = ${modelName},
          "dims" = ${SCHEMA_VECTOR_DIMS},
          "contentHash" = ${contentHash},
          "embedding" = ${vectorLiteral(embedding)},
          "updatedAt" = ${now}
        WHERE "documentId" = ${documentId}
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO "DocumentEmbedding" (
          "id", "workspaceId", "documentId", "model", "dims", "contentHash", "embedding", "createdAt", "updatedAt"
        ) VALUES (
          ${id},
          ${workspaceId},
          ${documentId},
          ${modelName},
          ${SCHEMA_VECTOR_DIMS},
          ${contentHash},
          ${vectorLiteral(embedding)},
          ${now},
          ${now}
        )
      `;
    }
  } catch (err) {
    logger.error(
      { documentId, err: String(err.message) },
      "document_embedding.upsert_failed"
    );
    return { ok: false, reason: "db_write_failed", error: String(err.message) };
  }

  return { ok: true };
}

/**
 * Vecinos por similitud coseno usando el embedding ya persistido del documento origen (sin round-trip del vector a Node).
 * `similarity` ≈ 1 - distancia coseno pgvector.
 *
 * @param {string} workspaceId
 * @param {string} sourceDocumentId
 * @param {object} opts
 * @param {string[]} [opts.relatedTypeKeys]
 * @param {number} [opts.limit]
 * @param {Date} [opts.createdAfter]
 * @returns {Promise<{ documentId: string, similarity: number }[]>}
 */
async function findSemanticNeighbors(workspaceId, sourceDocumentId, opts = {}) {
  if (!(await isPgVectorAvailable())) return [];

  const limit = Math.max(5, Math.min(200, Number(opts.limit || 30)));
  const relatedTypeKeys = Array.isArray(opts.relatedTypeKeys) ? opts.relatedTypeKeys.filter(Boolean) : [];
  const createdAfter =
    opts.createdAfter instanceof Date ? opts.createdAfter : new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

  const keyFrags = relatedTypeKeys.map((k) => Prisma.sql`${k}`);

  try {
    if (relatedTypeKeys.length === 0) {
      const rows = await prisma.$queryRaw`
        WITH src AS (
          SELECT embedding FROM "DocumentEmbedding"
          WHERE "documentId" = ${sourceDocumentId} AND "workspaceId" = ${workspaceId}
          LIMIT 1
        )
        SELECT
          de."documentId" AS "documentId",
          (1 - (de.embedding <=> (SELECT embedding FROM src)))::float AS similarity
        FROM "DocumentEmbedding" de
        INNER JOIN "DocumentRecord" dr ON dr.id = de."documentId"
        WHERE EXISTS (SELECT 1 FROM src)
          AND de."workspaceId" = ${workspaceId}
          AND de."documentId" <> ${sourceDocumentId}
          AND dr."createdAt" >= ${createdAfter}
        ORDER BY de.embedding <=> (SELECT embedding FROM src)
        LIMIT ${limit}
      `;
      return Array.isArray(rows) ? rows.map((r) => ({ documentId: r.documentId, similarity: Number(r.similarity) })) : [];
    }

    const rows = await prisma.$queryRaw`
      WITH src AS (
        SELECT embedding FROM "DocumentEmbedding"
        WHERE "documentId" = ${sourceDocumentId} AND "workspaceId" = ${workspaceId}
        LIMIT 1
      )
      SELECT
        de."documentId" AS "documentId",
        (1 - (de.embedding <=> (SELECT embedding FROM src)))::float AS similarity
      FROM "DocumentEmbedding" de
      INNER JOIN "DocumentRecord" dr ON dr.id = de."documentId"
      LEFT JOIN "DocumentType" dt ON dt.id = dr."documentTypeId"
      WHERE EXISTS (SELECT 1 FROM src)
        AND de."workspaceId" = ${workspaceId}
        AND de."documentId" <> ${sourceDocumentId}
        AND dr."createdAt" >= ${createdAfter}
        AND dt."key" IN (${Prisma.join(keyFrags)})
      ORDER BY de.embedding <=> (SELECT embedding FROM src)
      LIMIT ${limit}
    `;
    return Array.isArray(rows) ? rows.map((r) => ({ documentId: r.documentId, similarity: Number(r.similarity) })) : [];
  } catch (err) {
    logger.warn({ workspaceId, sourceDocumentId, err: String(err.message) }, "document_embedding.knn_query_failed");
    return [];
  }
}

module.exports = {
  SCHEMA_VECTOR_DIMS,
  isPgVectorAvailable,
  buildCanonicalMatchText,
  ensureDocumentEmbedded,
  findSemanticNeighbors,
};
