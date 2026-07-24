import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { env } from "./env";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// `tsx watch` reloads this module on every save. Without a guard, each reload
// would spin up a brand-new PrismaClient (and a new DB connection pool),
// eventually exhausting Neon's connection limit. Stashing the client on
// globalThis lets hot-reloads reuse the same instance. (This is the exact same
// singleton pattern you'll see in Next.js prisma setups, for the same reason.)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
