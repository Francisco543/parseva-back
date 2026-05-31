-- Catalogo base de tipos documentales BC por workspace.
ALTER TABLE "DocumentType" ADD COLUMN "baseTemplateKey" TEXT;
ALTER TABLE "DocumentType" ADD COLUMN "baseTemplateVersion" INTEGER;
ALTER TABLE "DocumentType" ADD COLUMN "isTemplateCustomized" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DocumentType" ADD COLUMN "templateCustomizedAt" TIMESTAMP(3);

CREATE INDEX "DocumentType_workspaceId_baseTemplateKey_idx"
  ON "DocumentType"("workspaceId", "baseTemplateKey");
