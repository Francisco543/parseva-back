-- Paridad con DocumentRecord: archivado en S3 / Azure Blob además de SharePoint.
ALTER TABLE "InvoiceRecord" ADD COLUMN "archiveIntegrationId" TEXT;
ALTER TABLE "InvoiceRecord" ADD COLUMN "archiveStorageKind" TEXT;
ALTER TABLE "InvoiceRecord" ADD COLUMN "archiveStorageExtra" JSONB;
