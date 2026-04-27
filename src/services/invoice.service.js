/**
 * @file Lectura de `InvoiceRecord` (lista paginada por workspace).
 * @module services/invoice
 */

const prisma = require("../lib/prisma");

/**
 * Lista las últimas facturas del workspace.
 *
 * @param {string} workspaceId
 * @param {{ take?: number }} [options]
 * @returns {Promise<import("@prisma/client").InvoiceRecord[]>}
 */
async function listInvoices(workspaceId, { take = 50 } = {}) {
  return prisma.invoiceRecord.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      emailMessage: {
        select: {
          id: true,
          subject: true,
          sender: true,
          receivedAt: true,
        },
      },
    },
  });
}

module.exports = {
  listInvoices,
};
