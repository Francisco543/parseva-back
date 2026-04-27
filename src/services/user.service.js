const prisma = require("../lib/prisma");

async function upsertUserFromToken(decodedToken) {
  const azureOid = decodedToken?.oid;
  if (!azureOid) return null;

  const email =
    decodedToken?.preferred_username || decodedToken?.email || null;
  const fullName = decodedToken?.name || null;

  return prisma.user.upsert({
    where: { azureOid },
    update: { email, fullName },
    create: { azureOid, email, fullName },
  });
}

module.exports = {
  upsertUserFromToken,
};
