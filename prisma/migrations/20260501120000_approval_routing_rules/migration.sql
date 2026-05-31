-- CreateTable
CREATE TABLE "ApprovalRoutingRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditionJson" JSONB NOT NULL,
    "assigneeUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRoutingRule_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "routingRuleId" TEXT;

-- CreateIndex
CREATE INDEX "ApprovalRoutingRule_workspaceId_documentTypeId_priority_idx" ON "ApprovalRoutingRule"("workspaceId", "documentTypeId", "priority");

-- CreateIndex
CREATE INDEX "ApprovalRequest_assigneeUserId_status_idx" ON "ApprovalRequest"("assigneeUserId", "status");

-- AddForeignKey
ALTER TABLE "ApprovalRoutingRule" ADD CONSTRAINT "ApprovalRoutingRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApprovalRoutingRule" ADD CONSTRAINT "ApprovalRoutingRule_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "DocumentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApprovalRoutingRule" ADD CONSTRAINT "ApprovalRoutingRule_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_routingRuleId_fkey" FOREIGN KEY ("routingRuleId") REFERENCES "ApprovalRoutingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
