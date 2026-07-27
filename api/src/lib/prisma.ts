import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

// POOL SIZING IS A DEPLOYMENT CONCERN, not a performance knob.
//
// On Vercel this app is a function that auto-scales, and EVERY instance builds
// its own pg Pool. Vercel caps file descriptors at 1,024 shared across all
// concurrent executions on an instance, and node-postgres defaults `max` to 10 —
// so the default quietly reserves ten descriptors per instance for connections
// that are idle most of the time. Three is enough: under Fluid compute one
// instance serves many invocations, but they are overwhelmingly waiting on
// OpenAI (seconds) rather than on Postgres (milliseconds).
//
// This is only safe against Neon's POOLED endpoint (host contains `-pooler`),
// which is what DATABASE_URL must be in production. The direct endpoint has a
// hard connection ceiling that N instances x 3 will find. Local dev keeps the
// direct string, because `prisma migrate deploy` needs it.
//
// `connectionTimeoutMillis` matters more here than anywhere: the default is 0,
// meaning "wait forever" for a free connection. On a long-lived server that is
// a stall; on a metered function it is a request that bills for its full
// duration and then times out at 300s with nothing to show. Fail fast instead.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10_000,
});

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
