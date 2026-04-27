const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");

function isRetryable(err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("timeout") || msg.includes("429") || msg.includes("rate");
}

async function queueBcSync(workspaceId, documentId, mappingProfileId) {
  const doc = await prisma.documentRecord.findFirst({ where: { id: documentId, workspaceId } });
  if (!doc) throw new HttpError(404, "Document not found");
  const profile = await prisma.bcMappingProfile.findFirst({
    where: { id: mappingProfileId, workspaceId, enabled: true },
    include: { bcTarget: true },
  });
  if (!profile) throw new HttpError(404, "BC mapping profile not found");
  if (!profile.bcTarget?.enabled) throw new HttpError(409, "BC target is disabled");
  if (profile.bcTarget.mode === "EXTENSION") {
    const ext = await prisma.bcExtensionTarget.findFirst({
      where: { workspaceId, bcTargetId: profile.bcTargetId },
    });
    if (!ext || ext.approvalStatus !== "APPROVED") {
      throw new HttpError(409, "BC extension target is not approved");
    }
  }

  const existingOpen = await prisma.bcSyncEvent.findFirst({
    where: {
      workspaceId,
      documentId: doc.id,
      mappingProfileId: profile.id,
      status: { in: ["PENDING", "SENT"] },
    },
  });
  if (existingOpen) return existingOpen;

  const event = await prisma.bcSyncEvent.create({
    data: {
      workspaceId,
      documentId: doc.id,
      mappingProfileId: profile.id,
      status: "PENDING",
      attempt: 0,
      requestJson: {
        targetKey: profile.bcTarget.key,
        fieldMap: profile.fieldMap,
        extractionJson: doc.extractionJson || {},
      },
    },
  });

  await prisma.documentRecord.update({
    where: { id: doc.id },
    data: { status: "ERP_QUEUED" },
  });

  return event;
}

async function processPendingBcSync(workspaceId, limit = 30) {
  const events = await prisma.bcSyncEvent.findMany({
    where: { workspaceId, status: "PENDING" },
    take: Math.min(100, Math.max(1, limit)),
    orderBy: { createdAt: "asc" },
    include: { mappingProfile: { include: { bcTarget: true } }, document: true },
  });

  const results = [];
  for (const ev of events) {
    try {
      await prisma.bcSyncEvent.update({
        where: { id: ev.id },
        data: { attempt: { increment: 1 }, status: "SENT" },
      });

      // Placeholder robusto: acá irá llamada real a conector AL.
      const mockedResponse = {
        accepted: true,
        externalRef: `BC-${ev.id.slice(0, 8)}`,
        target: ev.mappingProfile?.bcTarget?.key || null,
      };

      await prisma.$transaction(async (tx) => {
        await tx.bcSyncEvent.update({
          where: { id: ev.id },
          data: {
            status: "SYNCED",
            responseJson: mockedResponse,
            externalRef: mockedResponse.externalRef,
            lastError: null,
          },
        });
        if (ev.documentId) {
          await tx.documentRecord.update({
            where: { id: ev.documentId },
            data: { status: "ERP_SYNCED", lastError: null },
          });
        }
      });
      results.push({ eventId: ev.id, status: "SYNCED" });
    } catch (err) {
      const nextAttempt = ev.attempt + 1;
      const retry = isRetryable(err) && nextAttempt < 6;
      const retryDelayMs = Math.min(30 * 60 * 1000, nextAttempt * nextAttempt * 10000);
      const holdUntil = new Date(Date.now() + retryDelayMs);
      await prisma.bcSyncEvent.update({
        where: { id: ev.id },
        data: {
          status: retry ? "PENDING" : "FAILED",
          lastError: err instanceof Error ? err.message : String(err),
          responseJson: retry ? { retryNotBefore: holdUntil.toISOString() } : undefined,
        },
      });
      if (!retry && ev.documentId) {
        await prisma.documentRecord.update({
          where: { id: ev.documentId },
          data: { status: "FAILED", lastError: "BC sync failed" },
        });
      }
      results.push({ eventId: ev.id, status: retry ? "RETRY" : "FAILED" });
    }
  }

  return { processed: results.length, results };
}

async function listBcSyncEvents(workspaceId, status) {
  return prisma.bcSyncEvent.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      document: { select: { id: true, fileName: true, status: true } },
      mappingProfile: {
        select: { id: true, name: true, bcTarget: { select: { key: true, displayName: true } } },
      },
    },
  });
}

module.exports = {
  queueBcSync,
  processPendingBcSync,
  listBcSyncEvents,
};

