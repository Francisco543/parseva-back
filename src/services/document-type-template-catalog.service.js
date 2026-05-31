/**
 * Plantillas base de tipos documentales para Business Central.
 *
 * Se clonan por workspace para permitir personalización local sin afectar
 * al catálogo global.
 */

const DOCUMENT_TYPE_TEMPLATE_VERSION = 1;

/**
 * @typedef {object} DocTypeTemplate
 * @property {string} key
 * @property {string} displayName
 * @property {boolean} enabled
 * @property {string | null} sharePointPathTemplate
 * @property {boolean} requireApprovalBeforeErp
 * @property {Record<string, unknown> | null} aiExtractionSchema
 * @property {Record<string, unknown> | null} sharepointRouting
 * @property {Record<string, unknown> | null} matchingPolicy
 * @property {Record<string, unknown> | null} approvalPolicy
 * @property {Record<string, unknown> | null} validationPolicy
 * @property {Record<string, unknown> | null} bcPolicy
 */

/** @type {DocTypeTemplate[]} */
const DOCUMENT_TYPE_TEMPLATES = [
  {
    key: "invoice",
    displayName: "Facturas de compra",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{vendor_slug}/{invoice_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "vendor_tax_id", label: "CUIT/NIF proveedor", type: "string" },
        { key: "invoice_number", label: "Numero de factura", type: "string", required: true },
        { key: "invoice_date", label: "Fecha de factura", type: "string", required: true },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "subtotal", label: "Subtotal", type: "number" },
        { key: "tax_amount", label: "Impuestos", type: "number" },
        { key: "total_amount", label: "Total", type: "number", required: true },
      ],
    },
    sharepointRouting: {
      description: "Factura de proveedor con datos fiscales y montos completos.",
    },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["purchase_order", "delivery_note"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: true,
      minLinkScore: 0.72,
      semanticMatch: {
        enabled: true,
        semanticWeight: 0.55,
        semanticMinSimilarity: 0.6,
        neighborLimit: 8,
      },
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.86, requireHumanBelowThreshold: true },
    validationPolicy: {
      requiredExtractionPaths: ["vendor_name", "invoice_number", "invoice_date", "total_amount"],
    },
    bcPolicy: {
      enabled: true,
      syncMode: "AFTER_APPROVAL",
      autoMinConfidence: 0.9,
    },
  },
  {
    key: "purchase_order",
    displayName: "Ordenes de compra",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{po_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "po_number", label: "Numero OC", type: "string", required: true },
        { key: "po_date", label: "Fecha OC", type: "string" },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "buyer", label: "Comprador", type: "string" },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "total_amount", label: "Total OC", type: "number" },
      ],
    },
    sharepointRouting: {
      description: "Orden de compra para matching con remitos y facturas.",
    },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["delivery_note", "invoice"],
      relationCardinality: "ONE_TO_MANY",
      autoMatchAfterIngest: true,
      minLinkScore: 0.66,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.82, requireHumanBelowThreshold: true },
    validationPolicy: { requiredExtractionPaths: ["po_number", "vendor_name"] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "delivery_note",
    displayName: "Remitos / albaranes",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{delivery_note_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "delivery_note_number", label: "Numero remito", type: "string", required: true },
        { key: "delivery_date", label: "Fecha entrega", type: "string" },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "po_number", label: "OC relacionada", type: "string" },
        { key: "warehouse", label: "Deposito", type: "string" },
      ],
    },
    sharepointRouting: {
      description: "Documento de recepcion fisica para validar contra OC/factura.",
    },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["purchase_order", "invoice"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: true,
      minLinkScore: 0.62,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.8, requireHumanBelowThreshold: true },
    validationPolicy: { requiredExtractionPaths: ["delivery_note_number", "vendor_name"] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "credit_note",
    displayName: "Notas de credito",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{credit_note_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "credit_note_number", label: "Numero NC", type: "string", required: true },
        { key: "reference_invoice_number", label: "Factura referida", type: "string" },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "total_amount", label: "Importe NC", type: "number", required: true },
      ],
    },
    sharepointRouting: { description: "Ajuste de factura para registrar credito de proveedor." },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["invoice"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: true,
      minLinkScore: 0.67,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.84, requireHumanBelowThreshold: true },
    validationPolicy: {
      requiredExtractionPaths: ["credit_note_number", "vendor_name", "total_amount"],
    },
    bcPolicy: { enabled: true, syncMode: "AFTER_APPROVAL", autoMinConfidence: 0.9 },
  },
  {
    key: "debit_note",
    displayName: "Notas de debito",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{debit_note_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "debit_note_number", label: "Numero ND", type: "string", required: true },
        { key: "reference_invoice_number", label: "Factura referida", type: "string" },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "total_amount", label: "Importe ND", type: "number", required: true },
      ],
    },
    sharepointRouting: { description: "Ajuste de factura para registrar debito de proveedor." },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["invoice"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: true,
      minLinkScore: 0.67,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.84, requireHumanBelowThreshold: true },
    validationPolicy: {
      requiredExtractionPaths: ["debit_note_number", "vendor_name", "total_amount"],
    },
    bcPolicy: { enabled: true, syncMode: "AFTER_APPROVAL", autoMinConfidence: 0.9 },
  },
  {
    key: "bank_statement",
    displayName: "Extractos bancarios",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{account_number}",
    requireApprovalBeforeErp: false,
    aiExtractionSchema: {
      fields: [
        { key: "bank_name", label: "Banco", type: "string", required: true },
        { key: "account_number", label: "Cuenta", type: "string", required: true },
        { key: "period_start", label: "Periodo desde", type: "string" },
        { key: "period_end", label: "Periodo hasta", type: "string" },
        { key: "closing_balance", label: "Saldo cierre", type: "number" },
      ],
    },
    sharepointRouting: { description: "Extracto para conciliacion y auditoria contable." },
    matchingPolicy: { enabled: false },
    approvalPolicy: { minConfidenceForAutoPass: 0.78, requireHumanBelowThreshold: false },
    validationPolicy: { requiredExtractionPaths: ["bank_name", "account_number"] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "payment_receipt",
    displayName: "Recibos de pago",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{receipt_number}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "receipt_number", label: "Numero recibo", type: "string", required: true },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "payment_date", label: "Fecha pago", type: "string" },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "total_amount", label: "Monto", type: "number", required: true },
      ],
    },
    sharepointRouting: { description: "Comprobante de pago emitido por proveedor o banco." },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["invoice"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: true,
      minLinkScore: 0.65,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.82, requireHumanBelowThreshold: true },
    validationPolicy: {
      requiredExtractionPaths: ["receipt_number", "vendor_name", "total_amount"],
    },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "vendor_statement",
    displayName: "Estados de cuenta de proveedor",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{vendor_slug}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "statement_date", label: "Fecha estado", type: "string" },
        { key: "opening_balance", label: "Saldo inicial", type: "number" },
        { key: "closing_balance", label: "Saldo final", type: "number" },
      ],
    },
    sharepointRouting: { description: "Resumen de deuda/movimientos para conciliacion proveedor." },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["invoice", "payment_receipt", "credit_note"],
      relationCardinality: "ONE_TO_MANY",
      autoMatchAfterIngest: false,
      minLinkScore: 0.6,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.76, requireHumanBelowThreshold: true },
    validationPolicy: { requiredExtractionPaths: ["vendor_name"] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "withholding_certificate",
    displayName: "Certificados de retencion",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{vendor_slug}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "issuer_name", label: "Emisor", type: "string", required: true },
        { key: "vendor_name", label: "Proveedor", type: "string", required: true },
        { key: "certificate_number", label: "Numero certificado", type: "string", required: true },
        { key: "issue_date", label: "Fecha emision", type: "string" },
        { key: "tax_type", label: "Tipo impuesto", type: "string" },
        { key: "retained_amount", label: "Importe retenido", type: "number", required: true },
      ],
    },
    sharepointRouting: { description: "Soporte fiscal para contabilizacion de retenciones." },
    matchingPolicy: {
      enabled: true,
      relatedDocumentTypeKeys: ["invoice"],
      relationCardinality: "MANY_TO_ONE",
      autoMatchAfterIngest: false,
      minLinkScore: 0.62,
    },
    approvalPolicy: { minConfidenceForAutoPass: 0.83, requireHumanBelowThreshold: true },
    validationPolicy: {
      requiredExtractionPaths: [
        "issuer_name",
        "vendor_name",
        "certificate_number",
        "retained_amount",
      ],
    },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "expense_receipt",
    displayName: "Tickets y gastos menores",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}/{vendor_slug}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: {
      fields: [
        { key: "vendor_name", label: "Comercio", type: "string" },
        { key: "receipt_number", label: "Numero ticket", type: "string" },
        { key: "issue_date", label: "Fecha", type: "string", required: true },
        { key: "currency", label: "Moneda", type: "string" },
        { key: "total_amount", label: "Total", type: "number", required: true },
      ],
    },
    sharepointRouting: { description: "Gastos chicos para rendiciones o caja chica." },
    matchingPolicy: { enabled: false },
    approvalPolicy: { minConfidenceForAutoPass: 0.75, requireHumanBelowThreshold: true },
    validationPolicy: { requiredExtractionPaths: ["issue_date", "total_amount"] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.95 },
  },
  {
    key: "other",
    displayName: "Otros",
    enabled: true,
    sharePointPathTemplate: "/{year}/{month}/{document_type}",
    requireApprovalBeforeErp: true,
    aiExtractionSchema: { fields: [] },
    sharepointRouting: {
      description: "Fallback para documentos no clasificados en tipos estructurados.",
    },
    matchingPolicy: { enabled: false },
    approvalPolicy: { minConfidenceForAutoPass: 0.95, requireHumanBelowThreshold: true },
    validationPolicy: { requiredExtractionPaths: [] },
    bcPolicy: { enabled: false, syncMode: "MANUAL", autoMinConfidence: 0.98 },
  },
];

module.exports = {
  DOCUMENT_TYPE_TEMPLATE_VERSION,
  DOCUMENT_TYPE_TEMPLATES,
};
