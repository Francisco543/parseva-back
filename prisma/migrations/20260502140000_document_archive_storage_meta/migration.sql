-- Archivado multi-backend: referencia a integración usada + tipo + metadatos (etag, etc.)
ALTER TABLE "DocumentRecord" ADD COLUMN "archiveIntegrationId" TEXT;
ALTER TABLE "DocumentRecord" ADD COLUMN "archiveStorageKind" TEXT;
ALTER TABLE "DocumentRecord" ADD COLUMN "archiveStorageExtra" JSONB;
