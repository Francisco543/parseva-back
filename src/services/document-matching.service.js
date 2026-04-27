const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { normalizePolicies } = require("./document-type-policies");
const { ensureDocumentEmbedded, findSemanticNeighbors } = require("./document-embedding.service");

const createRuleSchema = z.object({
  documentTypeId: z.string().optional().nullable(),
  name: z.string().min(2).max(120),
  strategy: z.enum(["exact", "fuzzy", "ai_semantic"]),
  weight: z.number().min(0).max(10).optional().default(1),
  configJson: z.any(),
  enabled: z.boolean().optional().default(true),
});

const linkSchema = z.object({
  sourceDocumentId: z.string().min(1),
  targetDocumentId: z.string().min(1),
  linkType: z.string().min(1),
  score: z.number().min(0).max(1),
  status: z.enum(["MATCHED", "PARTIAL_MATCH", "NEEDS_REVIEW", "REJECTED"]),
  evidenceJson: z.any().optional(),
});

/**
 * Score determinístico en [0,1] a partir de campos de extracción (máx. teórico ~1.0).
 * @param {Record<string, unknown>} src
 * @param {Record<string, unknown>} tgt
 * @returns {number}
 */
function structuralMatchScore(src, tgt) {
  let score = 0;
  if (src.purchase_order && tgt.purchase_order && src.purchase_order === tgt.purchase_order) score += 0.55;
  if (src.vendor_tax_id && tgt.vendor_tax_id && src.vendor_tax_id === tgt.vendor_tax_id) score += 0.25;
  if (src.total_amount && tgt.total_amount) {
    const a = Number(src.total_amount);
    const b = Number(tgt.total_amount);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const diff = Math.abs(a - b);
      if (diff <= Math.max(2, a * 0.02)) score += 0.2;
    }
  }
  return Math.min(1, score);
}

/**
 * Combina score estructural y similitud semántica (coseno en [0,1]).
 * Sin componente semántica válida → solo estructural.
 * @param {number} structScore
 * @param {number|null|undefined} semanticSimilarity
 * @param {number} weightSemantic w en [0,1]
 */
function blendedMatchScore(structScore, semanticSimilarity, weightSemantic) {
  const w = typeof weightSemantic === "number" && weightSemantic > 0 ? Math.min(1, weightSemantic) : 0;
  if (w <= 0 || semanticSimilarity == null || !Number.isFinite(semanticSimilarity)) {
    return { finalScore: structScore, usedSemantic: false };
  }
  const sem = Math.max(0, Math.min(1, semanticSimilarity));
  const finalScore = (1 - w) * structScore + w * sem;
  return { finalScore: Math.min(1, finalScore), usedSemantic: true };
}

async function listMatchRules(workspaceId) {
  return prisma.matchRule.findMany({
    where: { workspaceId },
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
    include: { documentType: { select: { id: true, key: true, displayName: true } } },
  });
}

async function upsertMatchRule(workspaceId, id, payload) {
  const parsed = createRuleSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid match rule payload");
  if (!id) {
    return prisma.matchRule.create({
      data: { workspaceId, ...parsed.data },
    });
  }
  const existing = await prisma.matchRule.findFirst({ where: { id, workspaceId } });
  if (!existing) throw new HttpError(404, "Match rule not found");
  return prisma.matchRule.update({
    where: { id },
    data: parsed.data,
  });
}

async function listDocumentLinks(workspaceId, query = {}) {
  const status = query.status ? String(query.status) : null;
  return prisma.documentLink.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    orderBy: { updatedAt: "desc" },
    include: {
      sourceDocument: { select: { id: true, fileName: true, status: true, createdAt: true } },
      targetDocument: { select: { id: true, fileName: true, status: true, createdAt: true } },
    },
  });
}

async function upsertDocumentLink(workspaceId, payload) {
  const parsed = linkSchema.safeParse(payload || {});
  if (!parsed.success) throw new HttpError(400, "Invalid document link payload");
  const data = parsed.data;
  return prisma.documentLink.upsert({
    where: {
      sourceDocumentId_targetDocumentId_linkType: {
        sourceDocumentId: data.sourceDocumentId,
        targetDocumentId: data.targetDocumentId,
        linkType: data.linkType,
      },
    },
    create: {
      workspaceId,
      ...data,
    },
    update: {
      score: data.score,
      status: data.status,
      evidenceJson: data.evidenceJson || null,
    },
  });
}

const MATCH_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;

async function runAutoMatchForDocument(workspaceId, documentId) {
  const source = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
    include: { documentType: true },
  });
  if (!source) throw new HttpError(404, "Document not found");

  const matchPol = normalizePolicies(source.documentType || {}).matchingPolicy;
  if (!matchPol.enabled) {
    return { linked: 0, skipped: true, reason: "matching_disabled_for_type" };
  }

  const relatedKeys = matchPol.relatedDocumentTypeKeys || [];
  const typeFilter =
    relatedKeys.length > 0 ? { documentType: { is: { key: { in: relatedKeys } } } } : {};

  const heuristic = await prisma.documentRecord.findMany({
    where: {
      workspaceId,
      id: { not: source.id },
      ...typeFilter,
      createdAt: {
        gte: new Date(Date.now() - MATCH_WINDOW_MS),
      },
    },
    take: 100,
    orderBy: { createdAt: "desc" },
  });

  const semCfg = matchPol.semanticMatch || {};
  const semanticOn = semCfg.enabled === true && semCfg.semanticWeight > 0;

  /** @type {Map<string, number>} */
  const semanticById = new Map();
  let sourceHasEmbedding = false;

  if (semanticOn) {
    const embedResult = await ensureDocumentEmbedded(workspaceId, source.id);
    if (embedResult.ok) {
      sourceHasEmbedding = true;
      const neighbors = await findSemanticNeighbors(workspaceId, source.id, {
        relatedTypeKeys: relatedKeys,
        limit: semCfg.neighborLimit,
        createdAfter: new Date(Date.now() - MATCH_WINDOW_MS),
      });
      const minSem = semCfg.semanticMinSimilarity;
      for (const n of neighbors) {
        if (typeof n.similarity === "number" && n.similarity >= minSem) {
          semanticById.set(n.documentId, n.similarity);
        }
      }
    }
  }

  const heuristicById = new Map(heuristic.map((d) => [d.id, d]));
  const candidateIds = new Set(heuristic.map((d) => d.id));
  for (const id of semanticById.keys()) candidateIds.add(id);

  const missingIds = [...candidateIds].filter((id) => !heuristicById.has(id));
  if (missingIds.length) {
    const extra = await prisma.documentRecord.findMany({
      where: { workspaceId, id: { in: missingIds } },
    });
    for (const d of extra) heuristicById.set(d.id, d);
  }

  const srcEx = source.extractionJson && typeof source.extractionJson === "object" ? source.extractionJson : {};
  const links = [];
  const relation = matchPol.relationCardinality || "MANY_TO_MANY";
  const minScore = typeof matchPol.minLinkScore === "number" ? matchPol.minLinkScore : 0.35;
  const wSem = semanticOn && sourceHasEmbedding ? semCfg.semanticWeight : 0;

  async function cardinalityAllows(targetDocumentId) {
    if (relation === "MANY_TO_MANY") return true;
    const [sourceLinks, targetLinks] = await Promise.all([
      prisma.documentLink.count({
        where: { workspaceId, sourceDocumentId: source.id, linkType: "correlation_auto" },
      }),
      prisma.documentLink.count({
        where: { workspaceId, targetDocumentId, linkType: "correlation_auto" },
      }),
    ]);
    if (relation === "ONE_TO_ONE") return sourceLinks === 0 && targetLinks === 0;
    if (relation === "ONE_TO_MANY") return targetLinks === 0;
    if (relation === "MANY_TO_ONE") return sourceLinks === 0;
    return true;
  }

  for (const cid of candidateIds) {
    const c = heuristicById.get(cid);
    if (!c) continue;

    const tgtEx = c.extractionJson && typeof c.extractionJson === "object" ? c.extractionJson : {};
    const structScore = structuralMatchScore(srcEx, tgtEx);

    const semSim = semanticById.get(cid);

    const { finalScore, usedSemantic } = blendedMatchScore(structScore, semSim, wSem);

    if (finalScore < minScore) continue;
    if (!(await cardinalityAllows(c.id))) continue;

    const status =
      finalScore >= 0.8 ? "MATCHED" : finalScore >= 0.6 ? "PARTIAL_MATCH" : "NEEDS_REVIEW";
    const link = await upsertDocumentLink(workspaceId, {
      sourceDocumentId: source.id,
      targetDocumentId: c.id,
      linkType: "correlation_auto",
      score: Number(finalScore.toFixed(4)),
      status,
      evidenceJson: {
        purchase_order: srcEx.purchase_order || null,
        vendor_tax_id: srcEx.vendor_tax_id || null,
        structuralScore: Number(structScore.toFixed(4)),
        semanticSimilarity: semSim != null ? Number(semSim.toFixed(4)) : null,
        semanticUsed: usedSemantic,
        semanticWeight: wSem,
      },
    });
    links.push(link);
  }

  return { linked: links.length };
}

module.exports = {
  listMatchRules,
  upsertMatchRule,
  listDocumentLinks,
  upsertDocumentLink,
  runAutoMatchForDocument,
};
