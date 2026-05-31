/**
 * Ingesta de PDFs subidos manualmente (sin correo). Replica OCR, clasificación
 * (o tipo forzado), extracción por esquema y el merge de políticas del flujo
 * de `email-automation` para los documentos de este lote.
 *
 * @module services/manual-document-ingest
 */

const crypto = require("node:crypto");

const prisma = require("../lib/prisma");
const env = require("../config/env");
const HttpError = require("../utils/http-error");
const { logger } = require("../lib/logger");
const { createAuditEvent } = require("./audit.service");
const { coerceSettings } = require("./workspace-automation.service");
const {
  classifyDocument,
  classifyDocumentFromOcr,
  normalizeAiExtractionSchema,
  extractFieldsBySchema,
  extractFieldsFromOcr,
} = require("./document-extraction.service");
const {
  analyzeLayout: analyzeLayoutDi,
  isConfigured: isAzureDiConfigured,
} = require("./azure-doc-intelligence.service");

const MANUAL_CONTEXT = "Subida manual";

/**
 * @param {string} workspaceId
 */
async function ensureDocumentTypes(workspaceId) {
  let docTypes = await prisma.documentType.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
  if (docTypes.length === 0) {
    await prisma.documentType.createMany({
      data: [
        {
          workspaceId,
          key: "invoice",
          displayName: "Facturas",
          enabled: true,
          requireApprovalBeforeErp: true,
        },
        {
          workspaceId,
          key: "delivery_note",
          displayName: "Remitos",
          enabled: true,
          requireApprovalBeforeErp: true,
        },
        {
          workspaceId,
          key: "purchase_order",
          displayName: "Órdenes de compra",
          enabled: true,
          requireApprovalBeforeErp: true,
        },
        {
          workspaceId,
          key: "other",
          displayName: "Otros",
          enabled: true,
          requireApprovalBeforeErp: true,
        },
      ],
    });
    docTypes = await prisma.documentType.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }
  return docTypes;
}

/**
 * Merge de extracción + validación + umbral + matching/BC (mismo criterio que
 * `processEmailJob` para documentos del correo, pero sin extracción legacy de
 * factura global: `invoiceParsed` vacío).
 *
 * @param {string} workspaceId
 * @param {string[]} docIds
 * @param {Map<string, unknown>} perDocSchemaExtractions
 * @param {Record<string, unknown>} invoiceParsedStub
 */
async function applyMergePoliciesForDocuments(
  workspaceId,
  docIds,
  perDocSchemaExtractions,
  invoiceParsedStub
) {
  if (!docIds.length) return;

  const {
    normalizePolicies,
    validationErrorsForDocument,
    confidenceForDocument,
  } = require("./document-type-policies");
  const { runAutoMatchForDocument } = require("./document-matching.service");
  const { ensureDocumentEmbedded } = require("./document-embedding.service");
  const { queueBcSync } = require("./bc-sync.service");

  const p = invoiceParsedStub || {};

  const emailDocs = await prisma.documentRecord.findMany({
    where: { id: { in: docIds }, workspaceId },
    include: { documentType: true },
  });

  for (const docRow of emailDocs) {
    const prevCls =
      docRow.extractionJson && typeof docRow.extractionJson === "object"
        ? docRow.extractionJson.classification
        : undefined;
    const baseEx =
      docRow.extractionJson && typeof docRow.extractionJson === "object"
        ? { ...docRow.extractionJson }
        : {};
    delete baseEx.typeExtraction;

    const docType = docRow.documentType;
    const schemaNorm = normalizeAiExtractionSchema(docType?.aiExtractionSchema);
    const hasSchemaFields = schemaNorm.fields.length > 0;
    const te = perDocSchemaExtractions.get(docRow.id);
    const useSchema = Boolean(te && hasSchemaFields);

    const mergedExtraction = {
      ...baseEx,
      classification: prevCls,
    };

    if (useSchema && te) {
      /** @type {Record<string, unknown>} */
      const flatValues = {};
      /** @type {Record<string, { value: unknown, confidence: number | null, spans: unknown[], evidence: string | null }>} */
      const richFields = {};
      for (const [k, v] of Object.entries(te.fields || {})) {
        if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
          flatValues[k] = v.value;
          richFields[k] = {
            value: v.value === undefined ? null : v.value,
            confidence: typeof v.confidence === "number" ? v.confidence : null,
            spans: Array.isArray(v.spans) ? v.spans : [],
            evidence: typeof v.evidence === "string" ? v.evidence : null,
          };
        } else {
          flatValues[k] = v;
          richFields[k] = { value: v, confidence: null, spans: [], evidence: null };
        }
      }
      Object.assign(mergedExtraction, flatValues);
      mergedExtraction.fields = richFields;
      mergedExtraction.typeExtraction = {
        confidence: te.confidence,
        model: te.model,
        raw: te.raw,
        notes: te.notes,
        source: "aiExtractionSchema",
      };
    } else if (!hasSchemaFields && docType?.key === "invoice") {
      Object.assign(mergedExtraction, p);
    }

    const pol = normalizePolicies(docType || {});
    const valErrors = validationErrorsForDocument(mergedExtraction, docType?.validationPolicy);
    const extractionParsedForConf =
      useSchema ? null : docType?.key === "invoice" ? p : null;
    const conf = confidenceForDocument({ extractionJson: mergedExtraction }, extractionParsedForConf);

    let nextStatus = "EXTRACTED";
    if (docRow.status === "ARCHIVED") nextStatus = "ARCHIVED";
    else if (valErrors.length) nextStatus = "NEEDS_REVIEW";
    else if (
      pol.approvalPolicy.requireHumanBelowThreshold &&
      typeof conf === "number" &&
      conf < pol.approvalPolicy.minConfidenceForAutoPass
    ) {
      nextStatus = "NEEDS_APPROVAL";
    }

    await prisma.documentRecord.update({
      where: { id: docRow.id },
      data: {
        extractionJson: mergedExtraction,
        confidence: conf,
        status: nextStatus,
        lastError: valErrors.length ? `Validation: ${valErrors.join("; ")}` : null,
      },
    });

    if (nextStatus === "NEEDS_APPROVAL" && docRow.documentTypeId) {
      try {
        const { ensurePendingApprovalRequest } = require("./approval-routing.service");
        await ensurePendingApprovalRequest({
          documentId: docRow.id,
          workspaceId,
          documentTypeId: docRow.documentTypeId,
          extractionJson: mergedExtraction,
          documentConfidence: conf,
        });
      } catch {
        /* opcional */
      }
    }

    if (nextStatus === "NEEDS_REVIEW") {
      try {
        const { dispatchOutgoingWebhooks } = require("./webhook-outbound.service");
        dispatchOutgoingWebhooks(workspaceId, "document.needs_review", {
          documentId: docRow.id,
          status: nextStatus,
          validationErrors: valErrors,
        });
      } catch {
        /* opcional */
      }
    }

    if (pol.matchingPolicy.semanticMatch.enabled) {
      try {
        await ensureDocumentEmbedded(workspaceId, docRow.id);
      } catch {
        /* opcional */
      }
    }

    if (pol.matchingPolicy.enabled && pol.matchingPolicy.autoMatchAfterIngest) {
      try {
        await runAutoMatchForDocument(workspaceId, docRow.id);
      } catch {
        /* ignore */
      }
    }

    const canAutoErp =
      pol.bcPolicy.enabled &&
      pol.bcPolicy.syncMode === "AUTO_IF_CONFIDENT" &&
      pol.bcPolicy.mappingProfileId &&
      valErrors.length === 0 &&
      typeof conf === "number" &&
      conf >= pol.bcPolicy.autoMinConfidence &&
      nextStatus !== "NEEDS_APPROVAL" &&
      nextStatus !== "NEEDS_REVIEW" &&
      docType &&
      !docType.requireApprovalBeforeErp;

    if (canAutoErp) {
      try {
        await queueBcSync(workspaceId, docRow.id, pol.bcPolicy.mappingProfileId);
      } catch {
        /* opcional */
      }
    }
  }
}

/**
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workspaceId
 * @param {Array<{ buffer: Buffer, originalname?: string, mimetype?: string }>} params.files
 * @param {string | undefined} params.forcedDocumentTypeId
 * @param {boolean | undefined} params.suppressDuplicateInResults no marcar `isDuplicate` en la respuesta (reproceso)
 */
async function ingestManualPdfs({
  userId,
  workspaceId,
  files,
  forcedDocumentTypeId,
  suppressDuplicateInResults,
}) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) {
    throw new HttpError(404, "Workspace not found");
  }

  const settings = coerceSettings(workspace.automationSettings);
  const docTypes = await ensureDocumentTypes(workspaceId);

  if (forcedDocumentTypeId) {
    const okType = docTypes.some((t) => t.id === forcedDocumentTypeId);
    if (!okType) {
      throw new HttpError(400, "Tipo documental no encontrado en este workspace");
    }
  }

  const enabledTypeKeys = docTypes.filter((t) => t.enabled).map((t) => t.key);
  const documentTypesForClassifier = docTypes
    .filter((t) => t.enabled)
    .map((t) => {
      const sp = t.sharepointRouting && typeof t.sharepointRouting === "object" ? t.sharepointRouting : {};
      const hint =
        typeof sp.description === "string" && sp.description.trim() ? sp.description.trim().slice(0, 500) : null;
      return {
        key: t.key,
        displayName: (t.displayName && String(t.displayName).trim()) || t.key,
        hint,
      };
    });

  /** @type {Map<string, any>} */
  const perDocSchemaExtractions = new Map();
  /** @type {string[]} */
  const batchDocIds = [];
  /** @type {Array<{ fileName: string, ok: boolean, documentId?: string, status?: string, error?: string, isDuplicate?: boolean, duplicateUploadedAt?: string }>} */
  const results = [];

  if (!files?.length) {
    return { results: [] };
  }

  for (const file of files) {
    const originalname = file.originalname || "documento.pdf";
    const buffer = file.buffer;
    const contentType = file.mimetype || "application/pdf";
    const isPdf = contentType === "application/pdf" || /\.pdf$/i.test(originalname);

    if (!isPdf || !buffer?.length) {
      results.push({
        fileName: originalname,
        ok: false,
        error: "Solo se admiten archivos PDF",
      });
      continue;
    }

    const att = { buffer, name: originalname, contentType };

    try {
      const wsId = workspaceId;
      const sha256 = crypto.createHash("sha256").update(att.buffer).digest("hex");
      const existingDoc = await prisma.documentRecord.findFirst({
        where: {
          workspaceId: wsId,
          sha256,
        },
      });

      const isDuplicateSha = Boolean(existingDoc);

      let doc = existingDoc;
      if (!doc) {
        doc = await prisma.documentRecord.create({
          data: {
            userId,
            workspaceId: wsId,
            emailMessageId: null,
            fileName: att.name,
            contentType: att.contentType || null,
            sizeBytes: att.buffer?.length || null,
            sha256,
            status: "RECEIVED",
          },
        });
        await createAuditEvent({
          action: "document.created",
          userId,
          workspaceId: wsId,
          entityType: "DocumentRecord",
          entityId: doc.id,
          metadata: {
            source: "manual_upload",
            fileName: att.name,
            contentType: att.contentType,
            sizeBytes: att.buffer?.length || 0,
          },
        });
      }

      batchDocIds.push(doc.id);

      let layout = null;
      if (isAzureDiConfigured()) {
        try {
          const existingLayout = await prisma.documentLayout.findUnique({
            where: { documentId: doc.id },
          });
          if (existingLayout && existingLayout.rawHash === sha256) {
            layout = {
              modelId: existingLayout.modelId,
              apiVersion: existingLayout.apiVersion,
              pageCount: existingLayout.pageCount,
              pages: existingLayout.pages,
              tables: existingLayout.tables || [],
              fullText: existingLayout.fullText || "",
            };
          } else {
            layout = await analyzeLayoutDi(att.buffer, {
              contentType: att.contentType || "application/pdf",
            });
            await prisma.documentLayout.upsert({
              where: { documentId: doc.id },
              update: {
                workspaceId: wsId,
                modelId: layout.modelId,
                apiVersion: layout.apiVersion,
                pageCount: layout.pageCount,
                pages: layout.pages,
                tables: layout.tables,
                fullText: layout.fullText,
                rawHash: sha256,
              },
              create: {
                workspaceId: wsId,
                documentId: doc.id,
                modelId: layout.modelId,
                apiVersion: layout.apiVersion,
                pageCount: layout.pageCount,
                pages: layout.pages,
                tables: layout.tables,
                fullText: layout.fullText,
                rawHash: sha256,
              },
            });
            await createAuditEvent({
              action: "document.ocr.completed",
              userId,
              workspaceId: wsId,
              entityType: "DocumentRecord",
              entityId: doc.id,
              metadata: {
                pages: layout.pageCount,
                chars: layout.fullText.length,
                modelId: layout.modelId,
                apiVersion: layout.apiVersion,
                source: "manual_upload",
              },
            });
          }
        } catch (errOcr) {
          const msg = errOcr instanceof Error ? errOcr.message : String(errOcr);
          logger.warn(
            { component: "manual-ingest", err: msg, docId: doc.id },
            "Azure DI falló; el documento sigue sin OCR (fallback: PDF en OpenAI)"
          );
          await createAuditEvent({
            action: "document.ocr.failed",
            userId,
            workspaceId: wsId,
            entityType: "DocumentRecord",
            entityId: doc.id,
            metadata: { error: msg.slice(0, 400), source: "manual_upload" },
          });
        }
      }

      if (forcedDocumentTypeId) {
        const matchedType = docTypes.find((t) => t.id === forcedDocumentTypeId);
        const prevEx =
          doc.extractionJson && typeof doc.extractionJson === "object" ? { ...doc.extractionJson } : {};
        doc = await prisma.documentRecord.update({
          where: { id: doc.id },
          data: {
            documentTypeId: matchedType.id,
            status: "CLASSIFIED",
            confidence: 1,
            extractionJson: {
              ...prevEx,
              classification: {
                key: matchedType.key,
                confidence: 1,
                notes: "Tipo indicado al subir el archivo",
                model: "manual",
              },
              ocr: layout
                ? {
                    modelId: layout.modelId,
                    apiVersion: layout.apiVersion,
                    pageCount: layout.pageCount,
                  }
                : null,
            },
            lastError: null,
          },
        });
      } else if (!doc.documentTypeId) {
        const classification = layout
          ? await classifyDocumentFromOcr(
              {
                ocrText: layout.fullText || "",
                contextText: MANUAL_CONTEXT,
                allowedTypeKeys: enabledTypeKeys,
                documentTypes: documentTypesForClassifier,
              },
              { model: settings.openaiModel }
            )
          : await classifyDocument({
              fileName: att.name,
              pdfBuffer: att.buffer,
              contextText: MANUAL_CONTEXT,
              allowedTypeKeys: enabledTypeKeys,
              documentTypes: documentTypesForClassifier,
            });

        const matchedType =
          classification.key != null
            ? docTypes.find((t) => t.key === classification.key) ||
              docTypes.find((t) => t.key === "other") ||
              null
            : null;

        const classifiedOk = Boolean(matchedType);

        doc = await prisma.documentRecord.update({
          where: { id: doc.id },
          data: {
            documentTypeId: matchedType?.id || null,
            status: classifiedOk ? "CLASSIFIED" : "NEEDS_REVIEW",
            confidence: typeof classification.confidence === "number" ? classification.confidence : null,
            extractionJson: {
              classification,
              ocr: layout
                ? {
                    modelId: layout.modelId,
                    apiVersion: layout.apiVersion,
                    pageCount: layout.pageCount,
                  }
                : null,
            },
            ...(classifiedOk
              ? { lastError: null }
              : {
                  lastError:
                    "Clasificación: asigná un tipo documental manualmente o revisá la lista de tipos",
                }),
          },
        });

        await createAuditEvent({
          action: "document.classified",
          userId,
          workspaceId: wsId,
          entityType: "DocumentRecord",
          entityId: doc.id,
          metadata: {
            key: classification.key,
            confidence: classification.confidence,
            needsReview: !classifiedOk,
            source: layout ? "ocr+llm" : "pdf+llm",
            manualUpload: true,
          },
        });
      }

      if (
        doc.documentTypeId &&
        att.buffer &&
        settings.extractionEnabled !== false &&
        env.openaiApiKey
      ) {
        const typeRow = docTypes.find((t) => t.id === doc.documentTypeId);
        const schemaNorm = normalizeAiExtractionSchema(typeRow?.aiExtractionSchema);
        if (schemaNorm.fields.length > 0) {
          try {
            if (layout) {
              const teRich = await extractFieldsFromOcr(
                {
                  layout,
                  contextText: MANUAL_CONTEXT,
                  documentTypeKey: typeRow?.key || "documento",
                  documentTypeLabel: typeRow?.displayName || typeRow?.key || "documento",
                  schema: schemaNorm,
                },
                { model: settings.openaiModel }
              );
              perDocSchemaExtractions.set(doc.id, teRich);
            } else {
              const teLegacy = await extractFieldsBySchema(
                {
                  fileName: att.name,
                  pdfBuffer: att.buffer,
                  contextText: MANUAL_CONTEXT,
                  documentTypeKey: typeRow?.key || "documento",
                  documentTypeLabel: typeRow?.displayName || typeRow?.key || "documento",
                  schema: schemaNorm,
                },
                { model: settings.openaiModel }
              );
              const richFields = {};
              for (const [k, v] of Object.entries(teLegacy.fields || {})) {
                richFields[k] = { value: v, confidence: null, spans: [], evidence: null };
              }
              perDocSchemaExtractions.set(doc.id, {
                fields: richFields,
                confidence: teLegacy.confidence,
                notes: teLegacy.notes,
                model: teLegacy.model,
                raw: teLegacy.raw,
              });
            }
          } catch {
            /* degradación */
          }
        }
      }

      results.push({
        fileName: originalname,
        ok: true,
        documentId: doc.id,
        status: doc.status,
        ...(!suppressDuplicateInResults && isDuplicateSha && existingDoc
          ? {
              isDuplicate: true,
              duplicateUploadedAt: existingDoc.createdAt.toISOString(),
            }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ component: "manual-ingest", err: msg, fileName: originalname }, "Fallo al procesar PDF");
      results.push({
        fileName: originalname,
        ok: false,
        error: msg,
      });
    }
  }

  const uniqueBatchIds = [...new Set(batchDocIds)];
  if (uniqueBatchIds.length) {
    await applyMergePoliciesForDocuments(workspaceId, uniqueBatchIds, perDocSchemaExtractions, {});
    const rows = await prisma.documentRecord.findMany({
      where: { id: { in: uniqueBatchIds } },
      select: { id: true, status: true },
    });
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    for (const r of results) {
      if (r.ok && r.documentId) {
        const st = statusById.get(r.documentId);
        if (st) r.status = st;
      }
    }
  }

  return { results };
}

module.exports = {
  ingestManualPdfs,
};
