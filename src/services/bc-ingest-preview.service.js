const prisma = require("../lib/prisma");
const HttpError = require("../utils/http-error");
const {
  mergeExtractionForBc,
  buildOperationsFromProfiles,
  listMissingRequiredBcFields,
} = require("./bc-ingest-build.service");

/**
 * Vista previa del payload POST /ingest (sin encolar).
 *
 * @param {string} workspaceId
 * @param {string} documentId
 * @param {string} mappingProfileId
 */
async function buildBcIngestPreview(workspaceId, documentId, mappingProfileId) {
  const doc = await prisma.documentRecord.findFirst({
    where: { id: documentId, workspaceId },
  });
  if (!doc) throw new HttpError(404, "Document not found");

  const anchor = await prisma.bcMappingProfile.findFirst({
    where: { id: mappingProfileId, workspaceId, enabled: true },
    include: { bcTarget: true },
  });
  if (!anchor) throw new HttpError(404, "BC mapping profile not found");

  /** @type {Array<typeof anchor>} */
  let profiles;
  if (doc.documentTypeId) {
    profiles = await prisma.bcMappingProfile.findMany({
      where: {
        workspaceId,
        documentTypeId: doc.documentTypeId,
        enabled: true,
      },
      orderBy: [{ syncOrder: "asc" }, { createdAt: "asc" }],
      include: { bcTarget: true },
    });
    if (!profiles.some((p) => p.id === anchor.id)) {
      throw new HttpError(400, "El perfil no pertenece al tipo documental del documento");
    }
  } else {
    profiles = [anchor];
  }

  const merged = mergeExtractionForBc(doc);
  const missing = await listMissingRequiredBcFields(workspaceId, profiles, merged);
  const operations = buildOperationsFromProfiles(profiles, merged);

  return {
    merged,
    missing,
    operations,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      syncOrder: p.syncOrder,
      bcTargetKey: p.bcTarget.key,
    })),
  };
}

module.exports = {
  buildBcIngestPreview,
};
