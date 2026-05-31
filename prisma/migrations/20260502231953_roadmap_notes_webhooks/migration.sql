-- CreateTable
CREATE TABLE "DocumentNote" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutgoingWebhook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutgoingWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionFieldFeedback" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "reportedValue" JSONB,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionFieldFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentNote_documentId_createdAt_idx" ON "DocumentNote"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "OutgoingWebhook_workspaceId_enabled_idx" ON "OutgoingWebhook"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "WorkspaceApiKey_workspaceId_idx" ON "WorkspaceApiKey"("workspaceId");

-- CreateIndex
CREATE INDEX "ExtractionFieldFeedback_documentId_createdAt_idx" ON "ExtractionFieldFeedback"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentNote" ADD CONSTRAINT "DocumentNote_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentNote" ADD CONSTRAINT "DocumentNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutgoingWebhook" ADD CONSTRAINT "OutgoingWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceApiKey" ADD CONSTRAINT "WorkspaceApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionFieldFeedback" ADD CONSTRAINT "ExtractionFieldFeedback_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionFieldFeedback" ADD CONSTRAINT "ExtractionFieldFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
