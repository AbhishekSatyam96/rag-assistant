# RAG Knowledge Assistant

Upload your documents, ask questions about them, and get **streamed answers grounded in your own text with inline citations** — plus an honest refusal when your documents don't contain the answer.

**▶ Live at [rag.abhisheksatyam.com](https://rag.abhisheksatyam.com)** — sign up, paste a document or drop a PDF, and ask.

<!-- SCREENSHOT: add a shot of /ask mid-stream (answer partially typed, citation chips visible, sources listed).
     Save it to docs/images/ask.png and replace this comment with:
     ![Asking a question](docs/images/ask.png)
     A second shot of /documents showing a PDF processed to READY works well underneath. -->

---

## What it does

- **Bring your own text.** Paste content directly, or upload a PDF — text is extracted per page, so citations read "page 7", not "chunk 12".
- **Answers you can check.** Every claim carries a numbered citation back to the exact passage it came from, listed alongside the answer.
- **It says "I don't know."** Ask something your documents don't cover and it refuses, rather than inventing a confident answer.
- **Answers stream as they're written**, with sources appearing before the first word of the answer.
- **Your documents are yours.** Every query is scoped to the signed-in user at the database level.

## How it works

```
┌────────────────────────┐        ┌────────────────────────┐        ┌──────────────────┐
│ rag.abhisheksatyam.com │  JSON  │ api.abhisheksatyam.com │        │  Neon Postgres   │
│   Next.js 16 · Vercel  │ ─────► │   Express 5 · Vercel   │ ─────► │   + pgvector     │
│                        │ ◄───── │                        │ ◄───── │   (HNSW index)   │
│ /documents             │ NDJSON │ auth · documents       │        └──────────────────┘
│ /ask                   │ stream │ queries (RAG)          │        ┌──────────────────┐
└────────────────────────┘        └────────────────────────┘ ─────► │     OpenAI       │
                                                                    │ embeddings + LLM │
                                                                    └──────────────────┘
```

**Ingestion.** A document is hashed, split into overlapping chunks, embedded in batches, and written in a single transaction that inserts the chunks and flips the document to `READY` together. Embedding happens *outside* the transaction — a Postgres transaction is never held open across a slow third-party API call. Re-uploading identical text costs nothing and is deduped by the database.

**Retrieval.** The question is embedded, matched against the caller's chunks by approximate-nearest-neighbour search, and the top passages become a numbered context block for the model at temperature 0. Sources are streamed **before** the first token: retrieval is fast and generation is slow, so the citations fill the part of the wait the user actually feels.

Built deliberately as a real Express backend rather than Next.js API routes — the point was to build and defend a backend, not to let a framework manage one.

## Stack

| Layer | Choice |
|---|---|
| API | Express 5 + TypeScript (ESM) |
| ORM | Prisma 7, with raw SQL where pgvector needs it |
| Database | Neon Postgres + pgvector 0.8, HNSW index |
| Embeddings | `text-embedding-3-small` (1536-dim) |
| Generation | `gpt-4o-mini` by default, configurable |
| Auth | JWT (HS256) via `jose` + argon2id password hashing |
| Web | Next.js 16 · React 19 · Tailwind v4 |
| Hosting | Two Vercel projects from one repo |

---

## A few decisions worth defending

The full set lives in the design docs below — each is also written into the code it governs. Six that were worth the argument:

- **HNSW, not IVFFlat.** IVFFlat learns cluster centroids from existing data, so building it on a near-empty table produces a permanently bad index. HNSW builds incrementally — the only real option for a table that grows one upload at a time.

- **The index operator class and the query operator have to agree.** `vector_cosine_ops` in the index, `<=>` in the query. A mismatch never raises an error; it just silently stops using the index. The symptom is "slow but correct", which is exactly the kind of bug that survives all the way to production. Verified with `enable_seqscan = off` that `<=>` really plans as an index scan.

- **`404`, not `403`, for another user's document.** A `403` confirms the id exists, which lets someone enumerate ids to map another tenant's library. Both 404s are byte-identical so the message can't become an oracle. Ownership lives in the `WHERE` clause — never a lookup followed by an `if`.

- **NDJSON, not SSE.** `EventSource` can't set request headers, and auth is a Bearer token — SSE would force the token into the query string, where it lands in server logs, browser history, and `Referer`. That's a constraint, not a preference.

- **A fixed refusal string, not "say you don't know."** Left to its own judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. A verbatim constant is something the UI can detect and an eval harness can assert on.

- **`trust proxy` is a hop count, never `true`.** Unset, the rate limiter sees the platform's edge and the entire internet shares one bucket. Set to `true`, Express trusts the whole `X-Forwarded-For` chain — and since anyone can send that header, an attacker mints a fresh unlimited bucket per request.

## Design docs

This started as an exercise in designing a system properly, not just shipping one. All three mark **built** vs **degraded** vs **designed-not-built** explicitly, including the known gaps.

- **[High-Level Design](docs/hld.md)** — topology, capacity, failure modes, blast radius, and the scaling ladder.
- **[Low-Level Design](docs/lld.md)** — data model, state machines, sequence diagrams, API contracts, concurrency and idempotency semantics.
- **[Deployment notes](docs/deployment.md)** — what going live actually broke, what it cost architecturally, and how each piece was verified.

---

## Running it locally

<details>
<summary>Setup instructions</summary>

**Prerequisites:** Node 20+, pnpm, a Postgres database with the `vector` extension (Neon works out of the box), and an OpenAI API key. Redis is optional locally, required in production.

### 1. API

```bash
cd api
pnpm install
pnpm approve-builds          # @node-rs/argon2 needs its build script approved
```

Create `api/.env`:

```bash
DATABASE_URL="postgresql://…?sslmode=require"   # use the DIRECT host, not -pooler
JWT_SECRET="…"                                  # ≥32 chars: crypto.randomBytes(48).toString("hex")
OPENAI_API_KEY="sk-…"
# optional
CHAT_MODEL="gpt-4o-mini"
PORT=4000
NODE_ENV=development
WEB_ORIGIN="http://localhost:3000"
SIGNUP_INVITE_CODE="…"                          # unset = signup open to anyone
REDIS_URL="redis://localhost:6379"              # optional here, REQUIRED in production
```

Env is validated by zod at boot, so a missing or malformed variable fails immediately with a named error rather than deep inside a request.

`REDIS_URL` is where the rate limiters keep their counters. Leave it unset locally and they fall back to an in-memory store, so a fresh clone runs with nothing but Postgres. **With `NODE_ENV=production` the process refuses to start without it** — a per-process fallback on an autoscaling platform would give every instance its own counters, making the effective limit `limit × instances`. That failure reports correctly in every `RateLimit` header while enforcing nothing, so it's deliberately fatal rather than silent.

```bash
pnpm exec prisma migrate deploy   # ⚠️ deploy, not dev — see below
pnpm exec prisma generate
pnpm dev                          # http://localhost:4000
```

### 2. Web

```bash
cd web
pnpm install
echo 'NEXT_PUBLIC_API_URL="http://localhost:4000"' > .env.local
# add NEXT_PUBLIC_SIGNUP_INVITE_REQUIRED=true only when the api has SIGNUP_INVITE_CODE set
pnpm dev                          # http://localhost:3000
```

There's no seeded account — sign up at `/signup`, add a document at `/documents`, then ask about it at `/ask`.

### Smoke test

```bash
cd api
pnpm smoke:ingest           # live: real embeddings
pnpm smoke:ingest --fake    # deterministic stub, no paid calls
```

`ingestDocument` and `retrieveChunks` both accept an optional `embedFn` — a dependency-injection seam that lets the database path be exercised without an OpenAI bill.

### ⚠️ `prisma migrate dev` is unsafe on this database

The HNSW index sits on an `Unsupported()` column, so Prisma Migrate can't represent it. `migrate dev` reads that as drift and auto-generates a `DROP INDEX` — this corrupted migration history once already and forced a database reset. **Author migrations by hand (or with `prisma migrate diff`) and apply them with `prisma migrate deploy`**, which skips drift detection. `migrate status` is safe.

</details>

## Project structure

```
api/
  prisma/            # schema + migrations, incl. hand-written pgvector & HNSW SQL
  src/
    lib/             # chunk · embed · retrieve · answer · pdf · jwt · env
    middleware/      # requireAuth · rate limiting · errorHandler
    modules/         # auth · documents · queries  (routes → service → lib)
web/
  src/
    app/             # /login /signup /me /documents /ask
    components/      # AuthForm · DocumentForm/List · AnswerView · SourceList
    lib/             # api client (incl. streaming) · auth context
```

Backend layering is **routes → service → lib**: routes validate input and choose a status code, services hold orchestration, lib holds transport-free logic. The query service yields typed events and never touches `res` — only the route knows about HTTP, so swapping NDJSON for SSE or WebSockets wouldn't reopen the answer logic.

---

## Status

**Working today, deployed and verified end to end:** auth, document ingestion (paste or PDF), the documents dashboard, vector retrieval, and streamed grounded answers with citations — including that streaming really streams, and that an off-corpus question still refuses.

Because the app spends real money on behalf of anyone who signs up, `/queries` and `/auth/*` carry per-user burst and daily limits, a global daily ceiling, and a cap on concurrent streams — a rate limit bounds requests per window, not simultaneous in-flight generations. Counters live in Redis so they hold across instances.

**Next up — an evaluation harness:** a golden question set with retrieval hit-rate@k / MRR, groundedness, and refusal accuracy. It exists to settle the numbers currently chosen by judgement (`k`, chunk size, chunk overlap). Temperature 0 and the fixed refusal string are what make those metrics measurable in the first place.

**Deliberately deferred:** OCR for scanned PDFs (they're detected and rejected with a specific error), refresh-token rotation, per-user dollar metering, query persistence, and reranking / hybrid search / query rewriting — all held until evals can prove they help. There's no automated test suite yet either; verification so far is runtime scripts and end-to-end probes, with `createApp()` already factored for supertest.
