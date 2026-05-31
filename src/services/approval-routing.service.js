/**
 * CRUD de reglas de enrutado de aprobación y creación de `ApprovalRequest` pendiente.
 *
 * @module services/approval-routing
 */

const { z } = require("zod");
const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const { buildAllowedRuleFieldKeys, findFirstMatchingRule } = require("./approval-routing-eval.service");

const conditionSchema = z
  .object({
    op: z.enum(["always", "eq", "in", "contains_ci", "gt", "gte", "lt", "lte"]),
    field: z.string().trim().min(1).max(80).optional(),
    value: z.unknown().optional(),
    values: z.array(z.unknown()).max(80).optional(),
  })
  .strict();

const createRuleSchema = z.object({
  documentTypeId: z.string().min(1),
  priority: z.number().int().min(0).max(1_000_000).optional().default(0),
  conditionJson: z.unknown(),
  assigneeUserId: z.string().min(1),
});

const patchRuleSchema = z.object({
  priority: z.number().int().min(0).max(1_000_000).optional(),
  conditionJson: z.unknown().optional(),
  assigneeUserId: z.string().min(1).optional(),
});

/**
 * @param {unknown} conditionJson
 * @param {Set<string>} allowedFields
 */
function validateConditionForFields(conditionJson, allowedFields) {
  const parsed = conditionSchema.safeParse(conditionJson);
  if (!parsed.success) {
    throw new HttpError(400, "conditionJson inválido");
  }
  const { op, field } = parsed.data;
  if (op === "always") return;
  if (!field || !allowedFields.has(field)) {
    throw new HttpError(400, "Campo de condición no permitido para este tipo documental");
  }
  if ((op === "in" && (!Array.isArray(parsed.data.values) || parsed.data.values.length === 0))) {
    throw new HttpError(400, "Condición 'in' requiere values no vacío");
  }
  if (op !== "in" && op !== "always" && parsed.data.value === undefined) {
    throw new HttpError(400, "Condición requiere value");
  }
}

/**
 * @param {string} workspaceId
 * @param {string} userId
 */
async function assertUserMember(workspaceId, userId) {
  const m = await prisma.workspaceMembership.findFirst({
    where: { workspaceId, userId },
  });
  if (!m) throw new HttpError(400, "El responsable no pertenece a este workspace");
}

/**
 * @param {string} workspaceId
 * @param {string} documentTypeId
 */
async function assertDocumentTypeInWorkspace(workspaceId, documentTypeId) {
  const dt = await prisma.documentType.findFirst({
    where: { id: documentTypeId, workspaceId },
  });
  if (!dt) throw new HttpError(404, "Tipo documental no encontrado");
  return dt;
}

/**
 * @param {string} workspaceId
 * @param {string} documentTypeId
 */
async function listApprovalRoutingRules(workspaceId, documentTypeId) {
  await assertDocumentTypeInWorkspace(workspaceId, documentTypeId);
  return prisma.approvalRoutingRule.findMany({
    where: { workspaceId, documentTypeId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: {
      assignee: { select: { id: true, email: true, fullName: true } },
    },
  });
}

/**
 * @param {string} workspaceId
 * @param {unknown} body
 */
async function createApprovalRoutingRule(workspaceId, body) {
  const parsed = createRuleSchema.safeParse(body || {});
  if (!parsed.success) throw new HttpError(400, "Body inválido");

  const dt = await assertDocumentTypeInWorkspace(workspaceId, parsed.data.documentTypeId);
  const allowed = buildAllowedRuleFieldKeys(dt.aiExtractionSchema);
  validateConditionForFields(parsed.data.conditionJson, allowed);
  await assertUserMember(workspaceId, parsed.data.assigneeUserId);

  return prisma.approvalRoutingRule.create({
    data: {
      workspaceId,
      documentTypeId: parsed.data.documentTypeId,
      priority: parsed.data.priority,
      conditionJson: parsed.data.conditionJson,
      assigneeUserId: parsed.data.assigneeUserId,
    },
    include: {
      assignee: { select: { id: true, email: true, fullName: true } },
    },
  });
}

/**
 * @param {string} workspaceId
 * @param {string} ruleId
 * @param {unknown} body
 */
async function updateApprovalRoutingRule(workspaceId, ruleId, body) {
  const rule = await prisma.approvalRoutingRule.findFirst({
    where: { id: ruleId, workspaceId },
    include: { documentType: true },
  });
  if (!rule) throw new HttpError(404, "Regla no encontrada");

  const parsed = patchRuleSchema.safeParse(body || {});
  if (!parsed.success) throw new HttpError(400, "Body inválido");

  const allowed = buildAllowedRuleFieldKeys(rule.documentType?.aiExtractionSchema);
  const nextCondition = parsed.data.conditionJson !== undefined ? parsed.data.conditionJson : rule.conditionJson;
  validateConditionForFields(nextCondition, allowed);

  if (parsed.data.assigneeUserId) {
    await assertUserMember(workspaceId, parsed.data.assigneeUserId);
  }

  const data = {};
  if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;
  if (parsed.data.conditionJson !== undefined) data.conditionJson = parsed.data.conditionJson;
  if (parsed.data.assigneeUserId !== undefined) data.assigneeUserId = parsed.data.assigneeUserId;

  return prisma.approvalRoutingRule.update({
    where: { id: ruleId },
    data,
    include: {
      assignee: { select: { id: true, email: true, fullName: true } },
    },
  });
}

/**
 * @param {string} workspaceId
 * @param {string} ruleId
 */
async function deleteApprovalRoutingRule(workspaceId, ruleId) {
  const rule = await prisma.approvalRoutingRule.findFirst({
    where: { id: ruleId, workspaceId },
  });
  if (!rule) throw new HttpError(404, "Regla no encontrada");
  await prisma.approvalRoutingRule.delete({ where: { id: ruleId } });
}

/**
 * @param {string} workspaceId
 * @param {string} documentTypeId
 * @param {unknown} extractionJson
 * @param {number | null | undefined} documentConfidence
 * @returns {Promise<{ assigneeUserId: string, routingRuleId: string } | null>}
 */
async function resolveAssigneeForDocument(workspaceId, documentTypeId, extractionJson, documentConfidence) {
  const dt = await prisma.documentType.findFirst({
    where: { id: documentTypeId, workspaceId },
  });
  if (!dt) return null;

  const rules = await prisma.approvalRoutingRule.findMany({
    where: { workspaceId, documentTypeId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true, conditionJson: true, assigneeUserId: true },
  });
  if (!rules.length) return null;

  const allowed = buildAllowedRuleFieldKeys(dt.aiExtractionSchema);
  const matched = findFirstMatchingRule(rules, extractionJson, documentConfidence, allowed);
  return matched
    ? { assigneeUserId: matched.assigneeUserId, routingRuleId: matched.ruleId }
    : null;
}

/**
 * Reemplaza cualquier aprobación pendiente previa y crea una nueva asignación.
 *
 * @param {object} input
 * @param {string} input.documentId
 * @param {string} input.workspaceId
 * @param {string} input.documentTypeId
 * @param {unknown} input.extractionJson
 * @param {number | null | undefined} input.documentConfidence
 */
async function ensurePendingApprovalRequest(input) {
  const { documentId, workspaceId, documentTypeId, extractionJson, documentConfidence } = input;

  const resolved = await resolveAssigneeForDocument(
    workspaceId,
    documentTypeId,
    extractionJson,
    documentConfidence
  );

  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.deleteMany({
      where: { documentId, status: "PENDING" },
    });

    if (!resolved) return;

    await tx.approvalRequest.create({
      data: {
        workspaceId,
        documentId,
        status: "PENDING",
        assigneeUserId: resolved.assigneeUserId,
        routingRuleId: resolved.routingRuleId,
      },
    });
  });
}

/**
 * @param {string} workspaceId
 * @param {string} documentTypeId
 * @returns {Promise<string[]>}
 */
async function getAllowedRoutingFieldKeys(workspaceId, documentTypeId) {
  const dt = await assertDocumentTypeInWorkspace(workspaceId, documentTypeId);
  const set = buildAllowedRuleFieldKeys(dt.aiExtractionSchema);
  return [...set].sort();
}

module.exports = {
  listApprovalRoutingRules,
  createApprovalRoutingRule,
  updateApprovalRoutingRule,
  deleteApprovalRoutingRule,
  resolveAssigneeForDocument,
  ensurePendingApprovalRequest,
  buildAllowedRuleFieldKeys,
  getAllowedRoutingFieldKeys,
};
