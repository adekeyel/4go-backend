import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Standard singleton pattern so hot-reload (tsx watch) doesn't spawn
// a fresh PrismaClient (and a fresh connection pool) on every file change.
declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

export const prisma =
  global.__prisma__ ??
  new PrismaClient({
    log: env.isProd ? ["error", "warn"] : ["error", "warn"],
  });

if (!env.isProd) {
  global.__prisma__ = prisma;
}
