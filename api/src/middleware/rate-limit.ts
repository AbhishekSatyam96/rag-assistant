import { rateLimit, ipKeyGenerator, MINUTE, HOUR, DAY } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import type { Request } from "express";
import { HttpError } from "../lib/http-error.js";
import { env } from "../lib/env.js";
import { redis } from "../lib/redis.js";

// Aliased to a local const so TypeScript's narrowing survives into the
// sendCommand closure below. An imported binding is not narrowed inside a
// callback, since the module could in principle reassign it.
const client = redis;

// Every rate limit in the app, in one file.
//
// The policy is here rather than spread across route files for the same reason
// the prompt lives in one constant in lib/answer.ts: these numbers are a single
// decision about how much a stranger may cost us, and a decision you have to
// reassemble from five files is a decision nobody reviews.
//
// WHAT THIS DOES AND DOESN'T PROTECT
// A rate limiter bounds the NUMBER of requests per window. It does not bound
// dollars, and it does not bound concurrency:
//   - dollars      → sized below, per route, from the unit cost of that route.
//                    The real backstop is a spend cap on the OpenAI key itself,
//                    because that one still works when this file has a bug.
//   - concurrency  → middleware/concurrency.ts. A 10/min limit still allows ten
//                    simultaneous in-flight completions in the same second.
//
// STORE: Redis, via rate-limit-redis. Previously in-memory, with the note that
// "the fix is a one-line swap ... because everything below goes through
// makeLimiter()". That held — the seam was right and no limiter definition
// changed — but the swap was not one line, for a reason worth keeping:
//
// EVERY LIMITER NEEDS ITS OWN KEY PREFIX. rate-limit-redis defaults every store
// to the prefix `rl:`, and queryBurstLimiter (1 minute) and queryDailyLimiter
// (1 day) both key on req.user.id. Sharing a prefix means both would INCR the
// SAME Redis key with different expiries: the daily counter would be reset by
// the burst window, and the daily budget would silently stop existing. Nothing
// errors. The limits would just be wrong in a way that looks like flakiness.
// Hence `name` is required on LimiterConfig and becomes the prefix.
//
// In development REDIS_URL may be unset, in which case these fall back to the
// in-memory store so a clone runs with no infrastructure. That fallback is NOT
// reachable in production: lib/env.ts refuses to boot without REDIS_URL, because
// per-instance limits on an autoscaling platform report correctly in every
// header and enforce nothing.

// Sized against the per-request cost of each route (roughly: a query is one
// small embedding plus a ~2k-token gpt-4o-mini completion; an ingest is up to
// ~200 embeddings of a cheap model). They are deliberately generous for a human
// and hostile to a script: a person asking questions never approaches 10/min,
// while an unattended loop hits it in seconds.
const LIMITS = {
  // Sized for a link shared publicly, where a burst of unrelated strangers
  // arrives at once and a surprising number of them share one public IPv4:
  // mobile carriers run CGNAT, so "this address" can mean an entire city block
  // of subscribers. Too low here doesn't protect anything worth protecting —
  // signup costs no OpenAI money — it just turns real visitors away.
  signupPerHour: 15,
  loginPer15Min: 10,
  ingestPerHour: 10,
  queriesPerMinute: 10, // burst
  queriesPerDay: 50, // budget — see the note on why both exist
  // The shared ceiling, sized from cost rather than from caution: at roughly
  // $0.0004 an answer this is well under a dollar a day at full draw. Set low
  // enough to bound a bad day, high enough that a link doing well on social
  // does not read as a broken demo — which is the failure that actually costs
  // something here, since the whole point of the deployment is people trying it.
  // It takes 40 distinct accounts at their full 50/day to reach.
  queriesPerDayGlobal: 2000,
} as const;

type LimiterConfig = {
  /**
   * Unique, stable identifier for this limiter. Becomes the Redis key prefix.
   *
   * REQUIRED, not optional with a default — two limiters sharing a prefix while
   * sharing a key generator silently corrupt each other's counters, and the
   * type system is the only thing that can make that impossible to forget.
   * Changing a name resets that limiter's counters, which is harmless.
   */
  name: string;
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
};

function makeLimiter({
  name,
  windowMs,
  limit,
  message,
  keyGenerator,
  skipSuccessfulRequests = false,
}: LimiterConfig) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests,

    // Redis when configured, otherwise express-rate-limit's default memory
    // store. See the STORE note at the top of this file for why that fallback
    // cannot happen in production.
    store: client
      ? new RedisStore({
          prefix: `rl:${name}:`,
          // rate-limit-redis speaks raw commands so it stays client-agnostic.
          // ioredis's `call` takes the command and its arguments positionally,
          // which is exactly this signature.
          sendCommand: (...args: string[]) =>
            client.call(args[0], ...args.slice(1)) as Promise<never>,
        })
      : undefined,

    // draft-8 `RateLimit` / `RateLimit-Policy` headers, and none of the legacy
    // `X-RateLimit-*` ones. A client that wants to back off politely can read
    // its remaining budget without having to trip the limit first. The library
    // also sets `Retry-After` on rejection, before `handler` runs — so it
    // survives the hand-off to the error middleware below.
    standardHeaders: "draft-8",
    legacyHeaders: false,

    // Rate limiting a test suite means tests fail based on how many ran before
    // them. Turned off under NODE_ENV=test; the limiters themselves get tested
    // directly instead.
    skip: () => env.NODE_ENV === "test",

    // The default handler writes its own response body. Ours is `{ error }`
    // everywhere (middleware/error.ts), and a 429 that doesn't match the shape
    // every other error uses is a 429 the frontend renders as "Request failed
    // (429)". Handing it to next() keeps ONE place that formats errors — the
    // web client's existing `{ error }` parsing then displays it unchanged.
    handler: (_req, _res, next) => next(new HttpError(429, message)),
  });
}

// Unauthenticated routes have no identity to key on, so they key on IP.
//
// `ipKeyGenerator` rather than a bare `req.ip`: an IPv6 client is typically
// handed an entire /64, so keying on the exact address lets one machine rotate
// through more addresses than there are IPv4 addresses on Earth. The helper
// masks the address down to its subnet, which is the unit an attacker cannot
// trivially multiply. (It also satisfies express-rate-limit's own startup
// validation, which fails a custom keyGenerator that falls back to raw IP.)
//
// This is only correct if `trust proxy` is set to the exact number of proxy
// hops — see the note in app.ts. Get that wrong and this either keys every
// request in the world to one bucket, or lets a client mint a new bucket per
// request with a forged X-Forwarded-For header.
const byIp = (req: Request): string => ipKeyGenerator(req.ip ?? "unknown");

// Authenticated routes key on the user id, not the IP: the IP is shared by
// everyone behind a corporate NAT and changed at will by anyone on mobile data,
// so it is simultaneously too coarse and too easy to escape. The account is the
// thing that costs money, so the account is the thing that gets a budget.
//
// The `?? byIp` fallback is unreachable while these stay mounted behind
// requireAuth — it exists so that mounting one of them without auth degrades to
// a working IP limit rather than throwing.
const byUser = (req: Request): string => req.user?.id ?? byIp(req);

// --- auth --------------------------------------------------------------------

// Signup costs no OpenAI money directly, but it is the gate in front of
// everything that does: per-user budgets mean nothing if accounts are free and
// unlimited. It is also the most expensive route we run on our OWN hardware —
// argon2id is deliberately slow, so a signup flood is a CPU exhaustion attack
// on a single Cloud Run instance.
export const signupLimiter = makeLimiter({
  name: "signup",
  windowMs: 1 * HOUR,
  limit: LIMITS.signupPerHour,
  keyGenerator: byIp,
  message: "Too many accounts created from this address. Try again in an hour.",
});

// `skipSuccessfulRequests` is the difference between a limit that stops
// credential stuffing and a limit that punishes a real user for having two
// devices. Only failed logins consume the budget; sign in correctly and the
// count is refunded.
export const loginLimiter = makeLimiter({
  name: "login",
  windowMs: 15 * MINUTE,
  limit: LIMITS.loginPer15Min,
  keyGenerator: byIp,
  skipSuccessfulRequests: true,
  message: "Too many failed sign-in attempts. Try again in 15 minutes.",
});

// --- documents ---------------------------------------------------------------

// Embeds up to ~200 chunks per call (200k chars is the schema ceiling), plus
// the Postgres writes. Cheap per document, but it is the kind of route a script
// calls in a loop. Ten full-size ingests an hour is more than any human paste.
export const ingestLimiter = makeLimiter({
  name: "ingest",
  windowMs: 1 * HOUR,
  limit: LIMITS.ingestPerHour,
  keyGenerator: byUser,
  message: "Too many documents uploaded. Try again later.",
});

// --- queries -----------------------------------------------------------------

// TWO limiters on the same route, because burst and budget are different
// problems and a single window cannot express both:
//   - 10/min alone permits 14,400 requests a day.
//   - 50/day alone permits all 50 in one second.
// Mounted burst-first, so a flood is rejected by the cheap short window and
// never consumes the daily budget it was trying to drain.
export const queryBurstLimiter = makeLimiter({
  name: "query-burst",
  windowMs: 1 * MINUTE,
  limit: LIMITS.queriesPerMinute,
  keyGenerator: byUser,
  message: "You're sending questions too quickly. Wait a moment and try again.",
});

export const queryDailyLimiter = makeLimiter({
  name: "query-daily",
  windowMs: 1 * DAY,
  limit: LIMITS.queriesPerDay,
  keyGenerator: byUser,
  message: "You've reached today's question limit. It resets in 24 hours.",
});

// The backstop for the case the per-user limits cannot cover: not one abusive
// account, but many. Signup is open (a recruiter has to be able to try this),
// so "make another account" is always available to someone determined.
//
// The tradeoff is explicit and worth defending rather than hiding: this trades
// availability for cost. Enough traffic locks out everyone, including me. It is
// sized so that reaching it takes ten distinct accounts at their full daily
// budget, which is not something organic demo traffic does — and a demo that is
// briefly unavailable is strictly better than a bill I did not agree to.
export const globalQueryLimiter = makeLimiter({
  name: "query-global",
  windowMs: 1 * DAY,
  limit: LIMITS.queriesPerDayGlobal,
  keyGenerator: () => "global",
  message: "The demo has hit its daily usage limit. Please try again tomorrow.",
});
