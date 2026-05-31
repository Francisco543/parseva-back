-- AlterTable
ALTER TABLE "DocumentRecord" ADD COLUMN "bcStagingJson" JSONB;

-- AlterTable
ALTER TABLE "BcField" ADD COLUMN "uiHint" TEXT;
ALTER TABLE "BcField" ADD COLUMN "lookupRef" TEXT;

-- AlterTable
ALTER TABLE "BcMappingProfile" ADD COLUMN "syncOrder" INTEGER NOT NULL DEFAULT 0;
