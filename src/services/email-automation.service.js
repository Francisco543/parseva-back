const pdfParse = require("pdf-parse");

const { z } = require("zod");

const crypto = require("node:crypto");

const prisma = require("../lib/prisma");

const HttpError = require("../utils/http-error");

const env = require("../config/env");
const { publishEmailJob, publishEmailRetry, publishEmailDlq } = require("../lib/kafka");

const { graphRequest, graphGetBuffer } = require("../lib/graph-client");
const {
  classifyDocument,
  normalizeAiExtractionSchema,
  extractFieldsBySchema,
} = require("./document-extraction.service");

const {
  extractInvoiceFromText,
  normalizeParsedExtraction,
  isoStringToUtcDate,
} = require("./invoice-extraction.service");

const {
  buildStoragePath,
  safeFileName,
  uploadDriveItem,
  slugify,
} = require("./sharepoint.service");

const { coerceSettings } = require("./workspace-automation.service");
const { createAuditEvent } = require("./audit.service");

function isRetryableJobError(err) {
  if (err instanceof HttpError) {
    const code = Number(err.statusCode || 0);
    if (code === 408 || code === 409 || code === 425 || code === 429) return true;
    if (code >= 500 && code <= 599) return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("service unavailable")
  );
}

function retryDelayMs(attemptNumber) {
  // attemptNumber: 1 = primer intento (sin delay), 2..N = retries
  // Backoff simple y predecible: 1m, 10m, 1h, 6h...
  if (attemptNumber <= 1) return 0;
  if (attemptNumber === 2) return 60 * 1000;
  if (attemptNumber === 3) return 10 * 60 * 1000;
  if (attemptNumber === 4) return 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}



const ingestEmailSchema = z.object({

  integrationId: z.string().min(1),

  externalId: z.string().optional(),

  sender: z.string().email(),

  subject: z.string().min(1).max(300),

  receivedAt: z.string().datetime().optional(),

  rawPayload: z.record(z.string(), z.unknown()),

});



async function ingestEmailEvent(userId, workspaceId, payload) {

  const parsed = ingestEmailSchema.safeParse(payload);

  if (!parsed.success) {

    throw new HttpError(400, "Invalid email event payload");

  }



  const data = parsed.data;

  const integration = await prisma.integrationConnection.findFirst({

    where: { id: data.integrationId, userId, workspaceId, kind: "email" },

  });

  if (!integration) throw new HttpError(404, "Email integration not found");



  const emailMessage = await prisma.emailMessage.create({

    data: {

      userId,

      workspaceId,

      integrationId: integration.id,

      externalId: data.externalId,

      sender: data.sender,

      subject: data.subject,

      receivedAt: data.receivedAt ? new Date(data.receivedAt) : new Date(),

      rawPayload: data.rawPayload,

    },

  });



  const job = await prisma.processingJob.create({

    data: {

      userId,

      workspaceId,

      emailMessageId: emailMessage.id,

      queueKey: "email-ingestion",

      payload: {

        emailMessageId: emailMessage.id,

        sender: emailMessage.sender,

        subject: emailMessage.subject,

      },

    },

  });



  const enqueued = await publishEmailJob({

    jobId: job.id,

    userId,

    workspaceId,

    emailMessageId: emailMessage.id,

  });



  if (!enqueued) {

    await processEmailJob({ jobId: job.id, emailMessageId: emailMessage.id });

  }



  return { emailMessage, job, enqueued };

}



function stripHtml(html) {

  if (!html) return "";

  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

}



function looksInvoiceLike(subject, hasPdf) {

  if (hasPdf) return true;

  return /factura|invoice|cfdi|comprobante|boleta/i.test(subject || "");

}



function isProbablyPdf(fileName, contentType) {
  const n = String(fileName || "").toLowerCase();
  if (n.endsWith(".pdf")) return true;
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("pdf") || ct === "application/x-pdf";
}

async function loadMessageAttachments(tenantId, mailbox, messageId) {

  const query = new URLSearchParams();

  query.set(

    "$select",

    "subject,body,bodyPreview,hasAttachments,receivedDateTime,from"

  );

  query.set("$expand", "attachments");



  const full = await graphRequest(

    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}?${query.toString()}`,

    { method: "GET" },

    { tenantId }

  );



  const bodyText = stripHtml(full.body?.content) || full.bodyPreview || "";

  const attachmentTexts = [];

  const pdfAttachments = [];
  let primaryPdf = null;



  for (const att of full.attachments || []) {

    if (att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;

    const name = att.name || "adjunto";

    let buffer = null;



    if (att.contentBytes) {

      buffer = Buffer.from(att.contentBytes, "base64");

    } else if (att.id && Number(att.size || 0) < 25 * 1024 * 1024) {

      buffer = await graphGetBuffer(

        `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments/${att.id}/$value`,

        { tenantId }

      );

    }



    if (!buffer) continue;



    if (isProbablyPdf(name, att.contentType)) {

      try {

        const parsedPdf = await pdfParse(buffer);

        attachmentTexts.push({ name, text: parsedPdf.text || "" });

      } catch {

        attachmentTexts.push({ name, text: "" });

      }

      if (!primaryPdf) {

        primaryPdf = {

          buffer,

          name,

          contentType: att.contentType || "application/pdf",

        };

      }

      pdfAttachments.push({
        buffer,
        name,
        contentType: att.contentType || "application/pdf",
      });

    }

  }



  return { bodyText, attachmentTexts, primaryPdf, pdfAttachments, full };

}



async function processEmailJob({ jobId, emailMessageId }) {

  const job = await prisma.processingJob.findUnique({ where: { id: jobId } });

  if (!job) return;



  try {

    await prisma.processingJob.update({

      where: { id: jobId },

      data: { status: "RUNNING", attempts: { increment: 1 } },

    });



    const email = await prisma.emailMessage.findUnique({

      where: { id: emailMessageId },

      include: { integration: true },

    });

    if (!email) throw new Error("Email message not found");



    const existing = await prisma.invoiceRecord.findUnique({

      where: { emailMessageId: email.id },

    });

    if (existing && existing.status !== "FAILED") {

      await prisma.processingJob.update({

        where: { id: jobId },

        data: { status: "COMPLETED", lastError: null },

      });

      return;

    }



    const workspace = await prisma.workspace.findUnique({

      where: { id: email.workspaceId },

    });

    if (!workspace) throw new Error("Workspace not found");



    const settings = coerceSettings(workspace.automationSettings);

    const mailbox = email.integration?.configJson?.mailbox;



    let bodyText =

      stripHtml(email.rawPayload?.body?.content) ||

      email.rawPayload?.bodyPreview ||

      "";

    let attachmentTexts = [];

    let primaryPdf = null;
    let pdfAttachments = [];



    if (email.externalId && mailbox) {

      const loaded = await loadMessageAttachments(

        workspace.aadTenantId,

        mailbox,

        email.externalId

      );

      bodyText = loaded.bodyText || bodyText;

      attachmentTexts = loaded.attachmentTexts;

      primaryPdf = loaded.primaryPdf;
      pdfAttachments = loaded.pdfAttachments || [];

    }

    const hasPdf = pdfAttachments.length > 0;

    if (!hasPdf) {

      await prisma.emailMessage.update({

        where: { id: email.id },

        data: { status: "IGNORED" },

      });

      await prisma.processingJob.update({

        where: { id: jobId },

        data: { status: "COMPLETED", lastError: null },

      });

      await createAuditEvent({
        action: "document.ignored.no_pdf",
        userId: email.userId,
        workspaceId: email.workspaceId,
        entityType: "EmailMessage",
        entityId: email.id,
        metadata: { subject: email.subject, hasPdf },
      });

      return;

    }

    // Document types configurables por workspace. Si no hay ninguno, seed básico.
    let docTypes = await prisma.documentType.findMany({
      where: { workspaceId: email.workspaceId || undefined },
      orderBy: { createdAt: "asc" },
    });

    if ((email.workspaceId && docTypes.length === 0)) {
      await prisma.documentType.createMany({
        data: [
          { workspaceId: email.workspaceId, key: "invoice", displayName: "Facturas", enabled: true, requireApprovalBeforeErp: true },
          { workspaceId: email.workspaceId, key: "delivery_note", displayName: "Remitos", enabled: true, requireApprovalBeforeErp: true },
          { workspaceId: email.workspaceId, key: "purchase_order", displayName: "Órdenes de compra", enabled: true, requireApprovalBeforeErp: true },
          { workspaceId: email.workspaceId, key: "other", displayName: "Otros", enabled: true, requireApprovalBeforeErp: true },
        ],
      });
      docTypes = await prisma.documentType.findMany({
        where: { workspaceId: email.workspaceId },
        orderBy: { createdAt: "asc" },
      });
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

    /** @type {Map<string, { fields: Record<string, unknown>, confidence: number, notes: string | null, model: string, raw: string | null }>} */
    const perDocSchemaExtractions = new Map();

    // Crear un DocumentRecord por cada PDF adjunto.
    for (const att of pdfAttachments) {
      const wsId = email.workspaceId;
      if (!wsId) continue;

      const sha256 = crypto.createHash("sha256").update(att.buffer).digest("hex");
      const existingDoc = await prisma.documentRecord.findFirst({
        where: {
          workspaceId: wsId,
          sha256,
        },
      });

      let doc = existingDoc;
      if (!doc) {
        doc = await prisma.documentRecord.create({
          data: {
            userId: email.userId,
            workspaceId: wsId,
            emailMessageId: email.id,
            fileName: att.name,
            contentType: att.contentType || null,
            sizeBytes: att.buffer?.length || null,
            sha256,
            status: "RECEIVED",
          },
        });
        await createAuditEvent({
          action: "document.created",
          userId: email.userId,
          workspaceId: wsId,
          entityType: "DocumentRecord",
          entityId: doc.id,
          metadata: { fileName: att.name, contentType: att.contentType, sizeBytes: att.buffer?.length || 0 },
        });
      }

      // Clasificación por IA (tipos 100 % del workspace; BC solo si bcPolicy.enabled en ese tipo)
      if (!doc.documentTypeId) {
        const classification = await classifyDocument({
          fileName: att.name,
          pdfBuffer: att.buffer,
          contextText: `${email.subject}\n${bodyText || ""}`,
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
              classification: classification,
            },
            ...(classifiedOk
              ? { lastError: null }
              : {
                  lastError:
                    "Clasificación: asigná un tipo documental manualmente o revisá la lista de tipos (p. ej. agregar \"other\")",
                }),
          },
        });

        await createAuditEvent({
          action: "document.classified",
          userId: email.userId,
          workspaceId: wsId,
          entityType: "DocumentRecord",
          entityId: doc.id,
          metadata: {
            key: classification.key,
            confidence: classification.confidence,
            needsReview: !classifiedOk,
            ...(classification.rawModelKey ? { rawModelKey: classification.rawModelKey } : {}),
          },
        });
      }

      // NOTA: la subida a SharePoint del DocumentRecord se realiza en el bloque
      // diferido (post-extracción), una vez disponibles vendor/fecha/número y
      // los campos del schema del tipo. Aquí no subimos nada para evitar
      // archivos en rutas con placeholders sin datos (p. ej. "sin_nombre").

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
            const te = await extractFieldsBySchema(
              {
                fileName: att.name,
                pdfBuffer: att.buffer,
                contextText: `${email.subject}\n${bodyText || ""}`,
                documentTypeKey: typeRow?.key || "documento",
                documentTypeLabel: typeRow?.displayName || typeRow?.key || "documento",
                schema: schemaNorm,
              },
              { model: settings.openaiModel }
            );
            perDocSchemaExtractions.set(doc.id, te);
          } catch {
            /* degradación: el merge seguirá sin campos de esquema */
          }
        }
      }
    }



    let extraction;

    if (settings.extractionEnabled === false) {

      extraction = {

        parsed: normalizeParsedExtraction({

          vendor_name: null,

          vendor_tax_id: null,

          invoice_number: null,

          invoice_date: null,

          invoice_date_raw: null,

          due_date: null,

          currency: null,

          total_amount: null,

          subtotal: null,

          tax_amount: null,

          country: null,

          area: null,

          document_type: "invoice",

          purchase_order: null,

          confidence: 0,

          notes: "Extracción deshabilitada en el workspace",

        }),

        raw: null,

        model: "disabled",

        inputMode: "disabled",

      };

    } else {

      const contextAttachments = primaryPdf
        ? attachmentTexts.filter((a) => a.name !== primaryPdf.name)
        : attachmentTexts;

      extraction = await extractInvoiceFromText(
        {
          subject: email.subject,
          bodyText,
          attachmentTexts: contextAttachments,
          primaryPdf,
          attachmentTextsFallback: attachmentTexts,
        },
        { model: settings.openaiModel }
      );

    }

    const p = extraction.parsed || {};

    const vendorName = p.vendor_name || null;

    const invoiceDate = isoStringToUtcDate(p.invoice_date);

    const extractionStatus =

      settings.extractionEnabled === false

        ? "EXTRACTED"

        : p.confidence < 0.4

          ? "NEEDS_REVIEW"

          : "EXTRACTED";

    const extractionJson = {

      ...p,

      model: extraction.model,

      raw: extraction.raw,

      extraction_input_mode:

        extraction.inputMode ||

        (settings.extractionEnabled === false ? "disabled" : "unknown"),

    };



    const recordData = {

      status: extractionStatus,

      vendorName,

      vendorTaxId: p.vendor_tax_id || null,

      invoiceNumber: p.invoice_number || null,

      invoiceDate,

      currency: p.currency || null,

      totalAmount:

        typeof p.total_amount === "number" && !Number.isNaN(p.total_amount)

          ? p.total_amount

          : null,

      country: p.country || null,

      area: p.area || null,

      extractionJson,

      lastError: null,

      sharepointSiteId: null,

      sharepointDriveId: null,

      sharepointItemId: null,

      sharepointWebUrl: null,

      sharepointPath: null,

      fileName: null,

    };



    let invoiceRecord;

    if (existing) {

      invoiceRecord = await prisma.invoiceRecord.update({

        where: { id: existing.id },

        data: recordData,

      });

    } else {

      invoiceRecord = await prisma.invoiceRecord.create({

        data: {

          userId: email.userId,

          workspaceId: email.workspaceId,

          emailMessageId: email.id,

          ...recordData,

        },

      });

    }

    await createAuditEvent({
      action: existing ? "invoice.updated" : "invoice.created",
      userId: email.userId,
      workspaceId: email.workspaceId,
      entityType: "InvoiceRecord",
      entityId: invoiceRecord.id,
      metadata: {
        status: invoiceRecord.status,
        vendorName: invoiceRecord.vendorName,
        invoiceNumber: invoiceRecord.invoiceNumber,
        invoiceDate: invoiceRecord.invoiceDate,
        currency: invoiceRecord.currency,
      },
    });

    // DocumentRecord: el primer intento de SP va antes de la extraccion global (sin proveedor).
    // Reintenta aqui los que sigan sin URL para tipos "invoice" usando vendor/fecha/numero ya extraidos.
    if (settings.sharepointIntegrationId && email.workspaceId && pdfAttachments?.length) {
      const spDeferred = await prisma.integrationConnection.findFirst({
        where: {
          id: settings.sharepointIntegrationId,
          workspaceId: email.workspaceId,
          kind: "sharepoint",
        },
      });
      const cfgDef =
        spDeferred?.configJson && typeof spDeferred.configJson === "object" ? spDeferred.configJson : {};
      if (cfgDef.driveId) {
        const pendingDocs = await prisma.documentRecord.findMany({
          where: {
            emailMessageId: email.id,
            workspaceId: email.workspaceId,
            sharepointWebUrl: null,
          },
        });
        for (const dRow of pendingDocs) {
          if (!dRow.documentTypeId || !dRow.sha256) continue;
          const att = pdfAttachments.find(
            (a) => crypto.createHash("sha256").update(a.buffer).digest("hex") === dRow.sha256
          );
          if (!att?.buffer) continue;
          const typeRowDef = docTypes.find((t) => t.id === dRow.documentTypeId);
          const typeKeyDef = typeRowDef?.key || "other";
          const schemaNormDef = normalizeAiExtractionSchema(typeRowDef?.aiExtractionSchema);
          const teDef = perDocSchemaExtractions.get(dRow.id);
          const useInvoicePathVars = typeKeyDef === "invoice";
          let extractionFieldsDef = null;
          if (schemaNormDef.fields.length > 0 && teDef?.fields && typeof teDef.fields === "object") {
            extractionFieldsDef = teDef.fields;
          } else if (useInvoicePathVars) {
            extractionFieldsDef = {
              vendor_name: p.vendor_name ?? null,
              invoice_number: p.invoice_number ?? null,
              country: p.country ?? null,
              area: p.area ?? null,
              vendor_tax_id: p.vendor_tax_id ?? null,
            };
          }
          const routingDef =
            typeRowDef?.sharepointRouting && typeof typeRowDef.sharepointRouting === "object"
              ? typeRowDef.sharepointRouting
              : {};
          const typeRootDef =
            typeof routingDef.rootFolder === "string" && routingDef.rootFolder.trim()
              ? routingDef.rootFolder.trim()
              : settings.rootFolder;
          const typeTplDef = routingDef.pathTemplate || typeRowDef?.sharePointPathTemplate || null;
          try {
            const folderDef = buildStoragePath(
              typeTplDef || settings.pathTemplate,
              {
                vendorName: useInvoicePathVars ? vendorName : null,
                country: useInvoicePathVars ? p.country : null,
                area: useInvoicePathVars ? p.area : null,
                invoiceNumber: useInvoicePathVars ? p.invoice_number : null,
                receivedAt: email.receivedAt,
                invoiceDate: useInvoicePathVars ? invoiceDate : null,
                documentTypeKey: typeKeyDef,
                extractionFields: extractionFieldsDef || undefined,
              },
              typeRootDef
            );
            const baseDef = `${slugify(typeKeyDef || "documento")}_${dRow.sha256.slice(0, 10)}`;
            const relativeDef = `${folderDef}/${safeFileName(baseDef)}`;
            const uploadedDef = await uploadDriveItem(
              workspace.aadTenantId,
              cfgDef.driveId,
              relativeDef,
              att.buffer,
              att.contentType
            );
            await prisma.documentRecord.update({
              where: { id: dRow.id },
              data: {
                status: "ARCHIVED",
                sharepointSiteId: cfgDef.siteId || null,
                sharepointDriveId: cfgDef.driveId,
                sharepointItemId: uploadedDef?.id || null,
                sharepointWebUrl: uploadedDef?.webUrl || null,
                sharepointPath: relativeDef,
                lastError: null,
              },
            });
            await createAuditEvent({
              action: "document.archived.sharepoint",
              userId: email.userId,
              workspaceId: email.workspaceId,
              entityType: "DocumentRecord",
              entityId: dRow.id,
              metadata: {
                sharepointPath: relativeDef,
                webUrl: uploadedDef?.webUrl || null,
                phase: "post_extraction",
              },
            });
          } catch (errDef) {
            const msgDef = errDef instanceof Error ? errDef.message : String(errDef);
            await prisma.documentRecord.update({
              where: { id: dRow.id },
              data: { lastError: `SharePoint: ${msgDef}` },
            });
            await createAuditEvent({
              action: "document.archive_failed.sharepoint",
              userId: email.userId,
              workspaceId: email.workspaceId,
              entityType: "DocumentRecord",
              entityId: dRow.id,
              metadata: { error: msgDef, phase: "post_extraction" },
            });
          }
        }
      }
    }

    // Pipeline documento: extracción + validación + aprobación por umbral + matching/BC según tipo
    if (email.workspaceId) {
      const {
        normalizePolicies,
        validationErrorsForDocument,
        confidenceForDocument,
      } = require("./document-type-policies");
      const { runAutoMatchForDocument } = require("./document-matching.service");
      const { ensureDocumentEmbedded } = require("./document-embedding.service");
      const { queueBcSync } = require("./bc-sync.service");

      const emailDocs = await prisma.documentRecord.findMany({
        where: { emailMessageId: email.id, workspaceId: email.workspaceId },
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
          Object.assign(mergedExtraction, te.fields);
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

        if (pol.matchingPolicy.semanticMatch.enabled) {
          try {
            await ensureDocumentEmbedded(email.workspaceId, docRow.id);
          } catch {
            /* índice semántico opcional; matching puede degradar */
          }
        }

        if (pol.matchingPolicy.enabled && pol.matchingPolicy.autoMatchAfterIngest) {
          try {
            await runAutoMatchForDocument(email.workspaceId, docRow.id);
          } catch {
            /* ignore match errors in batch */
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
            await queueBcSync(email.workspaceId, docRow.id, pol.bcPolicy.mappingProfileId);
          } catch {
            /* ERP queue is optional */
          }
        }
      }
    }

    let jobNote = null;

    // Si ya existe un DocumentRecord archivado en SharePoint con el mismo SHA256
    // del PDF primario (mismo email, mismo workspace), reutilizamos ese archivo
    // en lugar de re-subirlo. Esto evita duplicar el mismo PDF en dos rutas
    // distintas (carpeta del tipo + carpeta base del workspace).
    if (settings.sharepointIntegrationId && primaryPdf?.buffer && email.workspaceId) {
      const primarySha = crypto.createHash("sha256").update(primaryPdf.buffer).digest("hex");
      const archivedDoc = await prisma.documentRecord.findFirst({
        where: {
          workspaceId: email.workspaceId,
          emailMessageId: email.id,
          sha256: primarySha,
          NOT: { sharepointWebUrl: null },
        },
        select: {
          id: true,
          sharepointSiteId: true,
          sharepointDriveId: true,
          sharepointItemId: true,
          sharepointWebUrl: true,
          sharepointPath: true,
          fileName: true,
        },
      });

      if (archivedDoc) {
        invoiceRecord = await prisma.invoiceRecord.update({
          where: { id: invoiceRecord.id },
          data: {
            status: "ARCHIVED",
            sharepointSiteId: archivedDoc.sharepointSiteId,
            sharepointDriveId: archivedDoc.sharepointDriveId,
            sharepointItemId: archivedDoc.sharepointItemId,
            sharepointWebUrl: archivedDoc.sharepointWebUrl,
            sharepointPath: archivedDoc.sharepointPath,
            fileName: archivedDoc.fileName || invoiceRecord.fileName,
            lastError: null,
          },
        });

        await createAuditEvent({
          action: "invoice.archived.sharepoint",
          userId: email.userId,
          workspaceId: email.workspaceId,
          entityType: "InvoiceRecord",
          entityId: invoiceRecord.id,
          metadata: {
            sharepointWebUrl: invoiceRecord.sharepointWebUrl,
            sharepointPath: invoiceRecord.sharepointPath,
            fileName: invoiceRecord.fileName,
            reusedFromDocumentRecord: archivedDoc.id,
          },
        });
      }
    }

    // Fallback: si no hay DocumentRecord archivado (p. ej. workspaces sin
    // tipos documentales o sin clasificación), conservamos el flujo legacy de
    // subida directa para el InvoiceRecord usando la plantilla por defecto.
    if (
      settings.sharepointIntegrationId &&
      primaryPdf?.buffer &&
      invoiceRecord.status !== "ARCHIVED"
    ) {

      const sp = await prisma.integrationConnection.findFirst({

        where: {

          id: settings.sharepointIntegrationId,

          workspaceId: email.workspaceId,

          kind: "sharepoint",

        },

      });

      const cfg =

        sp?.configJson && typeof sp.configJson === "object"

          ? sp.configJson

          : {};



      if (cfg.driveId) {

        try {

          const folder = buildStoragePath(

            settings.pathTemplate,

            {

              vendorName,

              country: p.country,

              area: p.area,

              invoiceNumber: p.invoice_number,

              receivedAt: email.receivedAt,

              invoiceDate,

            },

            settings.rootFolder

          );

          const dateStr =

            typeof p.invoice_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.invoice_date)

              ? p.invoice_date.slice(0, 10)

              : new Date(email.receivedAt).toISOString().slice(0, 10);

          const baseName = [

            slugify(vendorName || "proveedor"),

            dateStr,

            slugify(p.invoice_number || "") || invoiceRecord.id.slice(-8),

          ].join("_");

          const filename = safeFileName(baseName);

          const relative = `${folder}/${filename}`;

          const uploaded = await uploadDriveItem(

            workspace.aadTenantId,

            cfg.driveId,

            relative,

            primaryPdf.buffer,

            primaryPdf.contentType

          );



          invoiceRecord = await prisma.invoiceRecord.update({

            where: { id: invoiceRecord.id },

            data: {

              status: "ARCHIVED",

              sharepointSiteId: cfg.siteId || null,

              sharepointDriveId: cfg.driveId,

              sharepointItemId: uploaded?.id || null,

              sharepointWebUrl: uploaded?.webUrl || null,

              sharepointPath: relative,

              fileName: filename,

              lastError: null,

            },

          });

          await createAuditEvent({
            action: "invoice.archived.sharepoint",
            userId: email.userId,
            workspaceId: email.workspaceId,
            entityType: "InvoiceRecord",
            entityId: invoiceRecord.id,
            metadata: {
              sharepointWebUrl: invoiceRecord.sharepointWebUrl,
              sharepointPath: invoiceRecord.sharepointPath,
              fileName: invoiceRecord.fileName,
            },
          });

        } catch (err) {

          const msg = err instanceof Error ? err.message : String(err);

          jobNote = `SharePoint: ${msg}`;

          invoiceRecord = await prisma.invoiceRecord.update({

            where: { id: invoiceRecord.id },

            data: {

              lastError: jobNote,

            },

          });

          await createAuditEvent({
            action: "invoice.archive_failed.sharepoint",
            userId: email.userId,
            workspaceId: email.workspaceId,
            entityType: "InvoiceRecord",
            entityId: invoiceRecord.id,
            metadata: { error: jobNote },
          });

        }

      }

    }



    await prisma.emailMessage.update({

      where: { id: email.id },

      data: {

        status: invoiceRecord.status === "ARCHIVED" ? "ARCHIVED" : "ANALYZED",

      },

    });



    await prisma.processingJob.update({

      where: { id: jobId },

      data: { status: "COMPLETED", lastError: jobNote },

    });

  } catch (error) {

    const message = error instanceof Error ? error.message : String(error);
    const attemptNumber = (job.attempts || 0) + 1;
    const retryable = isRetryableJobError(error);
    const maxAttempts = Number(env.kafkaEmailMaxAttempts || 5);

    if (env.kafkaEnabled && retryable && attemptNumber < maxAttempts) {
      const delay = retryDelayMs(attemptNumber + 1);
      const notBefore = Date.now() + delay;
      const scheduledAt = new Date().toISOString();

      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: "RETRY_SCHEDULED",
          lastError: message,
        },
      });

      await publishEmailRetry({
        jobId,
        userId: job.userId,
        workspaceId: job.workspaceId,
        emailMessageId,
        attemptNumber: attemptNumber + 1,
        scheduledAt,
        notBefore,
        lastError: message,
      });

      await createAuditEvent({
        action: "job.retry_scheduled",
        userId: job.userId,
        workspaceId: job.workspaceId,
        entityType: "ProcessingJob",
        entityId: jobId,
        metadata: {
          attemptNumber: attemptNumber + 1,
          notBefore,
          delayMs: delay,
          error: message,
        },
      });
      return;
    }

    await prisma.processingJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        lastError: message,
      },
    });

    if (env.kafkaEnabled && retryable && attemptNumber >= maxAttempts) {
      await publishEmailDlq({
        jobId,
        userId: job.userId,
        workspaceId: job.workspaceId,
        emailMessageId,
        attemptNumber,
        lastError: message,
        failedAt: new Date().toISOString(),
      });
      await createAuditEvent({
        action: "job.sent_to_dlq",
        userId: job.userId,
        workspaceId: job.workspaceId,
        entityType: "ProcessingJob",
        entityId: jobId,
        metadata: { attemptNumber, error: message },
      });
      return;
    }

    await createAuditEvent({
      action: "job.failed",
      userId: job.userId,
      workspaceId: job.workspaceId,
      entityType: "ProcessingJob",
      entityId: jobId,
      metadata: { attemptNumber, error: message, retryable },
    });

  }

}



async function listEmailJobs(userId, workspaceId) {
  return prisma.processingJob.findMany({
    where: { userId, workspaceId, queueKey: "email-ingestion" },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      emailMessage: {
        select: {
          id: true,
          subject: true,
          status: true,
          sender: true,
          receivedAt: true,
        },
      },
    },
  });
}



module.exports = {

  ingestEmailEvent,

  processEmailJob,

  listEmailJobs,

};

