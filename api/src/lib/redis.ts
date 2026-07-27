import Redis from "ioredis";
import { env } from "./env.js";

// The Redis connection behind the rate limiters. Nothing else uses it yet.
//
// WHY ioredis (a TCP client) ON SERVERLESS, WHICH IS THE UNUSUAL CHOICE
// The instinct is that a connectionless HTTP client belongs on a function
// platform, and @upstash/ratelimit exists for exactly that. It was rejected
// because it does not implement express-rate-limit's Store interface, so
// adopting it means reimplementing three behaviours this app already depends on:
// draft-8 RateLimit headers, the `handler -> next(HttpError)` hand-off that
// keeps 429s in the same `{ error }` shape as every other error, and
// `skipSuccessfulRequests`, which is the entire basis of the login limiter's
// "a correct password is refunded" decision and is genuinely fiddly to redo
// (it has to decrement AFTER the response resolves).
//
// The usual argument against TCP here — a fresh connection per invocation —
// does not apply under Fluid compute, which reuses instances across many
// requests. This is one connection per instance, amortised, against a budget of
// 1,024 file descriptors. Preserving three deliberate design decisions is worth
// more than transport purity.

// `tsx watch` reloads this module on every save, and each reload would open
// another connection that the previous one never closes — the same reason
// lib/prisma.ts keeps its client on globalThis. In production the module is
// evaluated once per instance, so the guard is inert there.
const globalForRedis = globalThis as unknown as { redis?: Redis };

function createClient(url: string): Redis {
  const client = new Redis(url, {
    // A rate limiter must not become an availability risk for the thing it
    // protects. ioredis retries forever by default; if Redis is unreachable
    // that turns every request into a hang rather than a fast failure.
    maxRetriesPerRequest: 2,
    // Do not queue commands while disconnected — fail fast and let the limiter
    // surface the error, rather than accumulating work for a connection that
    // may never come back.
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    lazyConnect: false,
  });

  // ioredis emits 'error' on an EventEmitter with no listener, which crashes the
  // process. Logging keeps a transient blip from taking the API down with it.
  client.on("error", (err: Error) => {
    console.error(`[redis] ${err.message}`);
  });

  return client;
}

/**
 * The shared client, or `null` when REDIS_URL is unset.
 *
 * `null` is only reachable outside production — lib/env.ts refuses to boot a
 * production process without REDIS_URL, precisely so that this cannot silently
 * degrade to per-instance limits where it matters.
 */
export const redis: Redis | null = env.REDIS_URL
  ? (globalForRedis.redis ?? createClient(env.REDIS_URL))
  : null;

if (env.NODE_ENV !== "production" && redis) {
  globalForRedis.redis = redis;
}
