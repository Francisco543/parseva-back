-- DropIndex
DROP INDEX "DocumentEmbedding_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "DocumentLayout" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "apiVersion" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "pages" JSONB NOT NULL,
    "tables" JSONB,
    "fullText" TEXT,
    "rawHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLayout_documentId_key" ON "DocumentLayout"("documentId");

-- CreateIndex
CREATE INDEX "DocumentLayout_workspaceId_createdAt_idx" ON "DocumentLayout"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentLayout" ADD CONSTRAINT "DocumentLayout_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLayout" ADD CONSTRAINT "DocumentLayout_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
