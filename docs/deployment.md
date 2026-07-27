# Deployment plan — both apps on Vercel

**Decision:** `web/` and `api/` deploy as two Vercel projects from this one repo, on the
Hobby plan, at $0/month.

**Rejected, and why:**

- **Railway ($5/mo)** — architecturally the best fit (one persistent instance means the
  in-memory rate limiter and concurrency guard are *exactly* correct, no Redis, no body-size
  cap, no cancellation config). Rejected on cost alone for a portfolio piece.
- **Render free** — same architectural fit, but free services spin down after 15 minutes idle
  and take 30–60s to wake. A recruiter opens the link, waits 45 seconds, closes the tab. That
  single property outweighs everything else.
- **Cloud Run free tier** — the always-free allowance covers select **US** regions only, and
  the Neon branch is in `ap-southeast-1`. Either pay the trans-Pacific cost on every round
  trip of the retrieval path, or leave the free tier. Plus a GCP account, Artifact Registry
  and IAM before there's a URL. Still the better résumé line; revisit if the Dockerfile ever
  gets written.

**What Vercel gives us that the alternatives don't:** no new account or card, the domain is
already there, deploys ride the existing `git push`, preview deployments for the API too, and
Fluid compute's cold-start prevention means no 45-second first impression.

**What it costs us:** the single-instance guarantee the cost controls were designed around.
Phase 4 is where we buy it back.

## The shape

| | Root Directory | Domain | Notes |
| --- | --- | --- | --- |
| web | `web` | `rag.abhisheksatyam.com` | Next.js, zero-config |
| api | `api` | `api.abhisheksatyam.com` | Express → one Vercel Function |

Two subdomains of one apex is deliberate: they are **same-site**, so the deferred
httpOnly-cookie migration stays possible. A `*.vercel.app` API URL would be cross-site,
forcing `SameSite=None`, which Safari ITP and Firefox TCP block outright. Picking the
hostname now is what keeps that door open.

Both are still cross-origin, so CORS and `WEB_ORIGIN` stay exactly as they are.

---

## Phase 1 — make it start ✅ DONE 2026-07-27

Goal: a URL that answers `/health`. Nothing else.

**Verified live** at `https://rag-assistant-api.vercel.app`:

```
/health          {"status":"ok","users":6}                        200
/me (no token)   {"error":"Missing or malformed Authorization…"}   401
CORS preflight   204 + allow-origin: https://rag.abhisheksatyam.com
x-vercel-id      bom1::sin1::…        <- function really runs in Singapore
```

The `/me` 401 matters more than the 200: it proves the auth middleware, the
error middleware and Express routing are all live, not merely that a health
check responds.

### What it actually took — nine builds, nine distinct layers

Kept because the failures were each in a different subsystem, and every one of
them is a thing that only shows up on a platform and never locally:

| # | Symptom | Cause |
| --- | --- | --- |
| 1 | `EBADDEVENGINES` | Vercel couldn't parse the lockfile → fell back to npm → `devEngines` said "not npm" |
| 2–4 | `ERR_INVALID_THIS`, `ERR_PNPM_BROKEN_LOCKFILE` | `devEngines.onFail: "download"` makes pnpm write a **two-document** lockfile: 198 lines of pnpm installing itself, then the real one. Every reader that parses one document sees a lockfile with no dependencies. Also: `npm i -g pnpm` loses to the container's own pnpm on `PATH` (proved by echoing `pnpm --version` → `6.35.1`); `npx --yes pnpm@11.17.0` doesn't consult `PATH` |
| 5 | `No entrypoint found which imports express` | The entrypoint must **literally** `import express` — the detector doesn't follow the import graph — *and* default-export the app instance. Both halves, one file |
| 6 | `Cannot read properties of undefined (reading 'readFile')` | Vercel's builder drives the classic TS compiler API (`ts.sys`); TypeScript 7 is the native rewrite and doesn't expose it |
| 7 | `TS2307` on the generated Prisma client | `src/generated/prisma` is gitignored and nothing generated it |
| 8 | `ERR_MODULE_NOT_FOUND: './lib/prisma'` at **runtime**, build green | `"type": "module"` + `moduleResolution: "Bundler"` emits extensionless specifiers verbatim. Node ESM requires extensions. `tsx` resolves like a bundler, so dev, `tsc` and the editor all agree on code Node refuses to load |
| 9 | `TS2307` again, after it had been fixed | Vercel restored `node_modules` from cache → pnpm did nothing → **pnpm skips lifecycle scripts when it does nothing** → `postinstall` never ran |

**The one check that would have caught #8 before any of this:** compile and run
the output with plain Node.

```bash
rm -rf dist && pnpm exec tsc && PORT=4123 node dist/index.js
```

`tsx` and `tsc --noEmit` share a resolver with bundlers, not with Node. This is
the only local command that shares a module resolver with production. Run it
before every deploy.

**Two settings that look cosmetic and are not**, both commented where they live:
`importFileExtension = "js"` in `schema.prisma`, and every relative import in
`src/` ending in `.js`.

### 1.1 Entrypoint — the file Vercel finds first is the wrong one

Vercel auto-detects, **in this order**: `app.*`, `index.*`, `server.*`, then the same three
under `src/`. The file it finds must **default-export the app instance** (or call
`app.listen()`).

`src/app.ts` is first in that list and satisfies neither — it exports `createApp`, a named
factory. Decide explicitly which file is the entrypoint rather than letting detection order
decide for you.

Suggested: `src/index.ts` gains `export default createApp()`, and keeps `app.listen()` for
local `pnpm dev`. Vercel tolerates both patterns in one file, so this does not need a
separate serverless-only entrypoint.

The thing worth noticing: `createApp()` was factored out of `app.listen()` back in M1 "so a
test file can import it without opening a port." That decision is what makes this step three
lines instead of a restructure.

### 1.2 Function region → `sin1`

Vercel defaults to `iad1` (Washington DC). The Neon branch is `ap-southeast-1` (Singapore).

`lib/retrieve.ts` opens a transaction, issues two `SET LOCAL`s, then the vector query — four
or more sequential round trips per question. On the default region every one of them crosses
the Pacific. Hobby allows a single region, which is all we need; just don't leave the default.

### 1.3 Neon pooled connection string

The current `DATABASE_URL` has no `-pooler` in the host. Functions auto-scale to 30,000
concurrency and every instance opens its own `pg` Pool, against a **1,024 file descriptor
limit shared across concurrent executions**.

Use the pooled endpoint, and set the pool `max` small (1–3). Under Fluid compute one instance
serves many concurrent invocations, so a large per-instance pool buys nothing and spends
descriptors.

### 1.4 Environment variables

**api project:** `DATABASE_URL` (pooled), `JWT_SECRET`, `OPENAI_API_KEY`,
`WEB_ORIGIN=https://rag.abhisheksatyam.com`, `NODE_ENV=production`. Optional: `CHAT_MODEL`,
`SIGNUP_INVITE_CODE`.

`PORT` is unused on Vercel — harmless, since `lib/env.ts` defaults it.

Two traps:

- **`WEB_ORIGIN` is read raw from `process.env` at `app.ts:47`**, bypassing the validated
  `env` object, with a `?? "http://localhost:3000"` fallback. Forget it in production and CORS
  fails in a way that looks like a frontend bug. Consider moving it into the zod schema with
  no fallback under `NODE_ENV=production` — that's the same fail-fast argument `lib/env.ts`
  already makes for everything else.
- **If you set `SIGNUP_INVITE_CODE` on the API, you must also set
  `NEXT_PUBLIC_SIGNUP_INVITE_REQUIRED=true` on web.** Set one without the other
  (`AuthForm.tsx:33`) and the form hides the invite field while the server 403s every signup —
  an error nobody can act on.

### 1.5 Migrations — manual, and deliberately so

There is no release-command hook. Run `prisma migrate deploy` **from your laptop** against
production.

Do **not** put it in the build command: preview deployments would then migrate the production
database on every branch push. Given the HNSW drift situation already documented in STATUS.md,
manual and deliberate is the correct posture anyway.

> **Checkpoint:** `curl https://api.abhisheksatyam.com/health` returns `{"status":"ok"}`.
> Stop here and confirm before touching anything below.

---

## Phase 2 — verify what the platform silently changed

These are assumptions, not tasks. Test them before building on top of them.

### 2.1 Does NDJSON streaming survive?

`query.routes.ts` writes newline-delimited JSON progressively, and `web/src/lib/api.ts`
buffers lines over `ReadableStream`. Vercel supports streaming responses, and the Hobby max
duration is 300s against answers that take ~5s, so there is plenty of headroom.

But verify the *behaviour*, not the docs: ask a question against production and confirm tokens
arrive incrementally rather than as one buffered blob at the end. A buffered response is still
correct — it just silently deletes the entire UX the streaming design exists for.

### 2.2 Request cancellation is opt-in — this one costs money

`STATUS.md` says the `res.on("close")` → OpenAI `AbortController` wiring exists because "a
closed tab otherwise leaves us streaming tokens into a dead socket, billed in full."

**On Vercel that wiring does nothing unless you opt in**, per-path, in `api/vercel.json`:

```json
{ "functions": { "api/*": { "supportsCancellation": true } } }
```

Two things to verify rather than assume:

1. **The path glob actually matches the generated function.** An Express app becomes a single
   function; confirm the pattern covers it instead of trusting `api/*` from the docs example.
2. **Cancellation surfaces as an `AbortSignal`, which is not the same thing as an Express
   `res` `close` event.** The docs describe `Request.signal`; Express hands you an
   `IncomingMessage`, which has no `.signal`. It may well be that the socket close propagates
   and `res.on("close")` fires normally — but that is exactly the kind of assumption that
   fails silently and bills you for it.

Test: start a query, kill the tab, watch whether the OpenAI stream actually stops.

---

## Phase 3 — platform limits that collide with shipped features

### 3.1 The PDF upload cap is above the platform's

Vercel's request body limit is **4.5 MB**. `MAX_UPLOAD_BYTES` in `document.routes.ts:35` is
**10 MB**.

A 6 MB PDF gets a Vercel-generated `413 FUNCTION_PAYLOAD_TOO_LARGE` **at the edge**. It never
reaches Express, so the `MulterError` branch added to `middleware/error.ts` never runs and the
user gets a Vercel error page instead of the `{ error }` shape every other failure produces.

Lower `MAX_UPLOAD_BYTES` to ~4 MB so *our* 413 always fires first, and update the UI copy to
match. The comment at `document.routes.ts:44-49` — "multer's `limits` is the boundary" — is
now only true below 4.5 MB, and is worth amending.

The proper fix is Vercel Blob client-side uploads, which bypass the limit entirely. That's a
real feature, not a config change. Defer it.

### 3.2 Confirm `req.ip` is the caller

`app.set("trust proxy", 1)` is right for one proxy hop. Verify empirically that `req.ip`
resolves to the real client behind Vercel's edge and not an edge address — otherwise every
visitor on Earth shares one bucket, which is precisely the failure the comment at `app.ts:22`
describes. `express-rate-limit` validates this at startup and logs a warning on a mismatch;
read the deploy logs.

Vercel also sets `x-vercel-forwarded-for`, which is harder to spoof than `x-forwarded-for` if
this turns out to need hardening.

---

## Phase 4 — restore the cost controls

This is the phase that matters. Until it's done, signup is open to the internet in front of a
paid API with limits that report correctly and enforce nothing.

### 4.1 Rate limiter → Redis

`rate-limit.ts:22-26` already predicted this: *"On a single instance that is exact; behind an
autoscaler the effective limit is (limit × instance count). The fix is a one-line swap to
`rate-limit-redis` — not a redesign — because everything below goes through `makeLimiter()`."*

The seam holds. The swap is slightly more than one line, for two reasons.

**Which client.** Two candidates:

- **`rate-limit-redis` + `ioredis` over TCP** — keeps every behaviour of `express-rate-limit`
  that the current design depends on: draft-8 headers, the `handler → next(HttpError)`
  hand-off that preserves the `{ error }` shape, and critically `skipSuccessfulRequests`,
  which the login limiter's whole "refund a correct password" decision rests on.
- **`@upstash/ratelimit`** — HTTP, connectionless, purpose-built for serverless. But it does
  not implement the `express-rate-limit` store interface, so all three of the behaviours above
  get reimplemented by hand. `skipSuccessfulRequests` in particular is not trivial: it has to
  decrement *after* the response resolves.

**Recommendation: `rate-limit-redis` + `ioredis`.** The usual argument against TCP from
serverless is connection churn per invocation, but Fluid compute reuses instances, so it's one
connection per instance amortised across many requests — one file descriptor out of 1,024.
Preserving three documented design decisions is worth more than the transport purity.

**The trap: every limiter needs its own key prefix.** `queryBurstLimiter` (1 min) and
`queryDailyLimiter` (1 day) both key on `req.user.id`. `rate-limit-redis` defaults to the
prefix `rl:` for every store, so both would `INCR` the identical Redis key with different
expiries. The daily budget and the burst window would corrupt each other — and it would look
like the limits "sometimes work."

So `makeLimiter()` grows a required `name`, used as the store prefix. That's the actual change:
one new field on `LimiterConfig`, one `store:` line, six call sites passing a name. Still one
seam, exactly as predicted.

Upstash has a free tier and a Vercel marketplace integration. Each check is 1–2 Redis commands;
at demo scale it will not approach the free limit.

### 4.2 The concurrency guard — leave it alone

**I gave you the wrong advice on this earlier.** I said move it to Redis alongside the rate
limiter. Re-reading `concurrency.ts:17-22`, your own comment already answers it:

> *"A shared counter in Redis would actually be WORSE: it would need a lease with a timeout to
> survive a process dying mid-stream, whereas a Map in the process that holds the socket cannot
> outlive it."*

That argument survives serverless intact. Under Fluid compute the function instance owns the
socket, so the `Map` still exactly counts what it claims to count — open streams on this
instance, protecting this instance's event loop and sockets. It's not broken; it's scoped.

What *doesn't* survive is the cross-instance reading of it — "a user may hold 2 streams open"
becomes "2 per instance." That's the per-user **cost** bound, and Phase 4.1 is what re-establishes
it. Two different jobs that the single-instance deployment happened to let one `Map` do at once.

So: keep the code, amend the comment to separate the two claims. That's a better STATUS.md entry
than a Redis migration would have been.

---

## Phase 5 — frontend and domains

1. New Vercel project, **Root Directory `web`**. No root `package.json` or lockfile exists, and
   each subdirectory is a standalone pnpm project, so Vercel installs from `web/pnpm-lock.yaml`
   and never sees `api/`.
2. `NEXT_PUBLIC_API_URL=https://api.abhisheksatyam.com`.
   **This is substituted at build time by literal text replacement.** Forget it and you ship a
   production bundle asking every visitor's own machine for the API — a connection error with no
   server-side trace, unfixable without a redeploy. The `?? "http://localhost:4000"` fallback at
   `web/src/lib/api.ts:13` is worth reconsidering for production builds for exactly this reason.
3. Attach both subdomains. Check where DNS actually lives first: if the nameservers point at
   Vercel, the `api` CNAME goes in Vercel's DNS panel; if the apex sits at a registrar with
   records pointing at Vercel, it goes at the registrar.

The existing apex portfolio is untouched — Vercel scopes domains to the account and lets each
subdomain target a different project.

---

## Phase 6 — housekeeping

- **Stale comments naming Cloud Run:** `app.ts:24`, `app.ts:34`, `rate-limit.ts:127`. They
  describe reasoning that is still correct and infrastructure that is now wrong.
- **`document.routes.ts:44-49`** — the "multer's `limits` is the boundary" claim needs the
  4.5 MB caveat.
- **STATUS.md** — the deploy line still reads "Dockerize → Cloud Run + Vercel."

---

## What we're accepting, permanently

Worth writing down so it's a decision and not an oversight:

- **Autoscale cuts both ways.** A container under attack falls over; a function under attack
  scales to 30,000 concurrency and spends the OpenAI budget. After Phase 4 the only ceilings are
  the Redis rate limiter and the spend cap on the OpenAI key. There is no natural bound
  underneath them.
- **Statelessness closes a door on the roadmap.** Moving ingestion to `202 Accepted` + async is
  an in-process worker on a container; on Vercel it needs a queue or cron service.
- **Harder to debug** — no SSH, no long-lived process, logs are per-invocation.
- **argon2 on 1 vCPU** is slower than on a dedicated instance. It's deliberately expensive; that
  is the point. Not broken, just measurably slower.
- **Hobby is single-region and non-commercial.** If this ever becomes a real product, that's a
  Pro upgrade.
- **The narrative tension.** STATUS.md opens with "deliberately NOT Next.js API routes, because
  the goal is to show a real backend." Serverless Express is not that — separate service,
  separate domain, separate deploy, real middleware stack — but it is closer to it than a
  container is, and an interviewer may probe it. The honest answer is that being forced onto
  distributed rate limiting is a *more* senior problem than the in-memory version, and
  "I moved to Redis because the deployment model made in-memory limits dishonest" beats
  "my limits work because I pinned max-instances to 1."
