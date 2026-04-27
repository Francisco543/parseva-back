/**
 * @file Catálogo de acciones de auditoría.
 *
 * Convención: `<dominio>.<entidad>.<accion>` (snake/dot-case).
 *
 * Cualquier valor agregado aquí queda disponible para alertas y dashboards
 * en el frontend o en herramientas externas; mantener estabilidad.
 *
 * @module constants/audit-actions
 */

/**
 * @typedef {(typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION]} AuditAction
 */
const AUDIT_ACTION = Object.freeze({
  AUTOMATION_SETTINGS_UPDATED: "automation.settings.updated",

  INTEGRATION_CREATED: "integration.created",
  INTEGRATION_UPDATED: "integration.updated",

  GRAPH_SUBSCRIPTION_CREATED: "graph.subscription.created",

  DOCUMENT_TYPE_CREATED: "document.type.created",
  DOCUMENT_TYPE_UPDATED: "document.type.updated",

  DOCUMENT_CREATED: "document.created",
  DOCUMENT_CLASSIFIED: "document.classified",
  DOCUMENT_IGNORED_NO_PDF: "document.ignored.no_pdf",
  DOCUMENT_ARCHIVED_SHAREPOINT: "document.archived.sharepoint",
  DOCUMENT_ARCHIVE_FAILED_SHAREPOINT: "document.archive_failed.sharepoint",

  INVOICE_CREATED: "invoice.created",
  INVOICE_UPDATED: "invoice.updated",
  INVOICE_ARCHIVED_SHAREPOINT: "invoice.archived.sharepoint",
  INVOICE_ARCHIVE_FAILED_SHAREPOINT: "invoice.archive_failed.sharepoint",

  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",

  ERP_QUEUED: "erp.queued",
  BC_SYNC_QUEUED: "bc.sync.queued",
  BC_MAPPING_UPDATED: "business_central.mapping.updated",

  JOB_RETRY_SCHEDULED: "job.retry_scheduled",
  JOB_SENT_TO_DLQ: "job.sent_to_dlq",
  JOB_FAILED: "job.failed",
});

module.exports = {
  AUDIT_ACTION,
};
