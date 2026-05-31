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
  DOCUMENT_ARCHIVED_STORAGE: "document.archived.storage",
  DOCUMENT_ARCHIVE_FAILED_STORAGE: "document.archive_failed.storage",

  INVOICE_CREATED: "invoice.created",
  INVOICE_UPDATED: "invoice.updated",
  INVOICE_ARCHIVED_SHAREPOINT: "invoice.archived.sharepoint",
  INVOICE_ARCHIVE_FAILED_SHAREPOINT: "invoice.archive_failed.sharepoint",
  INVOICE_ARCHIVED_STORAGE: "invoice.archived.storage",
  INVOICE_ARCHIVE_FAILED_STORAGE: "invoice.archive_failed.storage",

  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",

  ERP_QUEUED: "erp.queued",
  BC_SYNC_QUEUED: "bc.sync.queued",
  /** Mensaje publicado en Kafka para procesar el `BcSyncEvent` (transporte asíncrono). */
  BC_SYNC_KAFKA_PUBLISHED: "bc.sync.kafka.published",
  /** Falló publicar en Kafka; el evento queda PENDING para drenaje manual o broker recuperado. */
  BC_SYNC_KAFKA_PUBLISH_FAILED: "bc.sync.kafka.publish_failed",
  /** Ingest BC completado correctamente (respuesta aceptada). */
  BC_SYNC_SUCCEEDED: "bc.sync.succeeded",
  /** Ingest BC falló sin más reintentos (o error no reintentable). */
  BC_SYNC_FAILED: "bc.sync.failed",
  /** Quedó PENDING para reintento tras error transitorio. */
  BC_SYNC_RETRY_SCHEDULED: "bc.sync.retry_scheduled",
  BC_MAPPING_UPDATED: "business_central.mapping.updated",

  JOB_RETRY_SCHEDULED: "job.retry_scheduled",
  JOB_SENT_TO_DLQ: "job.sent_to_dlq",
  JOB_FAILED: "job.failed",

  WORKSPACE_MEMBERSHIP_ROLE_UPDATED: "workspace.membership.role_updated",

  WORKSPACE_INVITE_CREATED: "workspace.invite.created",
  WORKSPACE_INVITE_REVOKED: "workspace.invite.revoked",
  WORKSPACE_INVITE_ACCEPTED: "workspace.invite.accepted",
});

module.exports = {
  AUDIT_ACTION,
};
