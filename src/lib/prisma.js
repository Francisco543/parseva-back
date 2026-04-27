/**
 * @file Cliente Prisma singleton del backend.
 *
 * Usa el adapter de Postgres (`@prisma/adapter-pg`) y reutiliza la instancia
 * en `globalThis.prisma` durante el desarrollo para evitar múltiples
 * conexiones cuando hot-reload reimporta el módulo.
 *
 * @module lib/prisma
 */

const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

const globalForPrisma = /** @type {{ prisma?: PrismaClient }} */ (globalThis);
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL for Prisma adapter");
}

const adapter = new PrismaPg({ connectionString });

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
