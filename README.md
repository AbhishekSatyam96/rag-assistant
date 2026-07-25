# RAG Knowledge Assistant

Upload your documents, ask questions about them, get **streamed answers grounded in your own text with inline citations** — and a refusal when the corpus doesn't contain the answer.

Built as a proof-piece: a real Express backend (deliberately *not* Next.js API routes), Postgres + pgvector for retrieval, and a Next.js frontend that streams tokens as they're generated.

```
┌──────────────┐        ┌───────────────────────┐        ┌──────────────────┐
│  Next.js 16  │  JSON  │      Express 5        │        │  Neon Postgres   │
│   web/:3000  │ ─────► │      api/:4000        │ ─────► │   + pgvector     │
│              │ ◄───── │                       │ ◄───── │   (HNSW index)   │
│ /documents   │ NDJSON │ auth · documents      │        └──────────────────┘
│ /ask         │ stream │ queries (RAG)         │        ┌──────────────────┐
└──────────────┘        └───────────────────────┘ ─────► │     OpenAI       │
                                                         │ embeddings + LLM │
                                                         └──────────────────┘
```

---

## How it works

### Ingestion (write path)

```
POST /documents  →  sha256 dedupe  →  split (1000 chars / 200 overlap)
                 →  embed batches of 100 (text-embedding-3-small, 1536-dim)
                 →  ONE transaction: insert chunks + UPDATE embeddings + flip status
```

A document moves `PENDING → PROCESSING → READY | FAILED`. Chunking and embedding happen **outside** any database transaction — a Postgres transaction is never held open across a slow third-party API call. Content is hashed first, so re-uploading identical text costs nothing and returns `200 { deduped: true }` instead of a misleading `201 Created`.

### Retrieval (read path)

```
POST /queries  →  embed the question  →  ANN search over the caller's chunks only
               →  numbered context block  →  LLM at temperature 0
               →  NDJSON: sources → token* → done | error
```

Vector search is raw SQL (`ORDER BY embedding <=> $1::vector`) because Prisma has no model of the pgvector operators. That means the compiler stops enforcing tenant isolation, so `WHERE d."userId" = ...` is written into the query by hand and flagged with a comment block — see [retrieve.ts](api/src/lib/retrieve.ts).

Sources are emitted **before** the first token: retrieval is fast, generation is slow, and filling the screen with citations covers the part of the wait the user actually feels.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Express 5 + TypeScript (ESM, `tsx`) | A real backend, not framework-managed routes |
| ORM | Prisma 7 + `@prisma/adapter-pg` | Typed queries; raw SQL where pgvector needs it |
| DB | Neon Postgres + pgvector 0.8 | Serverless Postgres, HNSW index for ANN search |
| Embeddings | `text-embedding-3-small` (1536-dim) | Hardcoded constant — see decisions below |
| Generation | `CHAT_MODEL`, default `gpt-4o-mini` | Env var — a model swap is a deploy decision |
| Chunking | `@langchain/textsplitters` | `RecursiveCharacterTextSplitter` |
| Auth | `jose` (JWT HS256) + `@node-rs/argon2` | ESM/edge-native; argon2id with prebuilt binaries |
| Validation | `zod` 4 | Boot-time env validation + per-request body schemas |
| Web | Next.js 16 · React 19 · Tailwind v4 | App Router, `fetch` + `ReadableStream` for streaming |

---

## API surface

| Method | Route | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, users }` |
| `POST` | `/auth/signup` | — | `201 { user, token }` |
| `POST` | `/auth/login` | — | `200 { user, token }` |
| `GET` | `/me` | ✅ | Identity decoded from the token |
| `POST` | `/documents` | ✅ | `{ title, content }` → `201`, or `200` when deduped |
| `GET` | `/documents` | ✅ | Summaries — no `content`, no embeddings |
| `GET` | `/documents/:id` | ✅ | `404` for another user's id, never `403` |
| `POST` | `/queries` | ✅ | `{ question, k? }` → NDJSON stream |

`requireAuth` is applied at the **mount point**, not per route, so a route added later cannot accidentally ship unauthenticated.

### The `/queries` stream

One JSON object per line (`application/x-ndjson`):

```jsonc
{"type":"sources","sources":[{"n":1,"documentTitle":"…","chunkIndex":0,"content":"…","similarity":0.82}]}
{"type":"token","value":"The "}
{"type":"token","value":"answer "}
{"type":"done","answer":"The answer is … [1]"}
```

NDJSON rather than SSE because `EventSource` cannot set request headers, and auth is a Bearer token — SSE would force the token into a query string, where it lands in server logs, browser history, and `Referer`. That's a constraint, not a preference.

---

## Data model

```
User ──< Document ──< Chunk
         status, contentHash,   content, chunkIndex,
         chunkCount             embedding vector(1536)
```

- `@@unique([userId, contentHash])` — dedupe is enforced by the database, not just checked in code.
- `chunkCount` is denormalised onto `Document` and written in the same transaction as the rows it counts, so listing documents never needs a `COUNT(*)`.
- `embedding` is `Unsupported("vector(1536)")` — Prisma treats it as opaque, which is what drives the migration caveat below.

---

## Running it locally

**Prerequisites:** Node 20+, pnpm, a Postgres database with the `vector` extension available (Neon works out of the box), and an OpenAI API key.

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
```

Env is validated by zod at boot, so a missing or malformed var fails immediately with a named error rather than deep inside a request.

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
pnpm dev                          # http://localhost:3000
```

There's no seeded account — sign up at `/signup` (email + password ≥ 8 chars), paste a document at `/documents`, then ask about it at `/ask`.

### Smoke test

```bash
cd api
pnpm smoke:ingest           # live: real embeddings
pnpm smoke:ingest --fake    # deterministic stub, no paid calls
```

`ingestDocument` and `retrieveChunks` both accept an optional `embedFn` — a DI seam that lets the database path be exercised without an OpenAI bill.

### ⚠️ `prisma migrate dev` is unsafe on this database

The HNSW index sits on an `Unsupported()` column, so Prisma Migrate can't represent it. `migrate dev` reads that as drift and auto-generates a `DROP INDEX` — this already corrupted migration history once and forced a database reset. **Author migrations by hand (or with `prisma migrate diff`) and apply them with `prisma migrate deploy`**, which skips drift detection. `migrate status` is safe.

---

## Decisions worth defending

A selection — the full list with rationale lives in [STATUS.md](STATUS.md).

- **`vector_cosine_ops` in the index, `<=>` in the query.** The operator class and the operator must agree. Verified with `enable_seqscan = off`: `<=>` plans as an index scan, `<->` (L2) still plans as `Seq Scan + Sort`. A mismatch never errors — it silently stops using the index, so the symptom is "slow but correct", which survives all the way to production.
- **HNSW, not IVFFlat.** IVFFlat learns cluster centroids from existing data, so building it on a near-empty table produces a permanently bad index. HNSW builds incrementally — the only option for a table that grows one upload at a time.
- **`hnsw.iterative_scan = 'strict_order'`.** An ANN index knows nothing about `userId`, so Postgres post-filters: it walks the index in distance order and *then* discards other tenants' rows. Ask for top-5 and you can get 2, or 0 — correct, never a leak, but it silently under-returns and gets worse as users are added.
- **`SET LOCAL`, not `SET`.** `SET` mutates the pooled connection's session, so one query's tuning becomes global config for whichever request gets that connection next. This is also why the read path has a transaction around it at all.
- **No distance threshold on retrieval.** Semantic search always returns *something*; a cutoff would be a magic number tuned by vibes. The prompt does the refusing — verified: an off-corpus question retrieves a source at similarity 0.33 and still returns the exact refusal string.
- **A fixed `REFUSAL` constant, not "say you don't know".** Left to its own judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. A verbatim string is something the UI can detect and an eval harness can assert on.
- **Embedding model hardcoded, generation model an env var.** Changing `CHAT_MODEL` is a deploy decision; changing the embedding model invalidates every vector in the database. One belongs in config, the other must never be a flag someone can flip.
- **Headers deferred until the first stream event.** A response has exactly one status code, committed at the first byte. Generators are lazy, so retrieval failures still throw while a real status is available; only post-header failures become an in-band `error` event.
- **`404`, not `403`, for another user's document.** A `403` confirms the id exists, letting an attacker enumerate ids to map another tenant's library. Both 404s are byte-identical so the message can't become an oracle.
- **Ownership lives in the `WHERE` clause.** `findFirst({ where: { id, userId } })`, never `findUnique({ id })` plus a follow-up `if`. Structural, not one forgotten branch away from a leak.
- **Citations parsed at render time from the accumulated string.** Mid-stream a marker arrives as `[`, then `[1`, then `[1]`. Re-deriving each render makes a half-typed marker render as literal text and become a chip the instant it completes.
- **Buffer NDJSON lines and use `TextDecoder({ stream: true })`.** A network chunk respects neither line boundaries nor UTF-8 character boundaries. Both bugs work perfectly on short ASCII answers and break on long or accented ones — the worst possible failure schedule. Verified by feeding the parser a body one byte at a time.

---

## Project structure

```
api/
  prisma/
    schema.prisma
    migrations/                     # incl. hand-written pgvector + HNSW SQL
  src/
    app.ts                          # createApp() — factored for supertest
    lib/                            # chunk · embed · retrieve · answer · jwt · env
    middleware/                     # requireAuth · errorHandler
    modules/
      auth/                         # routes → service → schema
      documents/                    # ingestion + read path
      queries/                      # RAG orchestration, typed event stream
    scripts/smoke-ingest.ts
web/
  src/
    app/                            # /login /signup /me /documents /ask
    components/                     # AuthForm · DocumentForm/List · AnswerView · SourceList
    lib/                            # api.ts (incl. streamAsk) · auth-context · use-require-auth
```

Backend layering is **routes → service → lib**: routes validate input and pick a status code, services hold orchestration, lib holds transport-free logic. The query service yields typed events and never touches `res` — only the route knows about HTTP, so swapping NDJSON for SSE or WebSockets wouldn't reopen the answer logic.

---

## Status & roadmap

**Working today:** auth (backend + frontend), document ingestion, the `/documents` dashboard, vector retrieval, and streamed grounded answers with citations at `/ask`.

**Next — evaluation harness:** a golden question set, retrieval hit-rate@k / MRR, groundedness and refusal accuracy. It exists to settle the numbers currently chosen by judgement (`k = 5`, `chunkSize 1000`, `chunkOverlap 200`). `temperature: 0` and the fixed refusal string are what make those metrics measurable.

**Deliberately deferred:** file upload / PDF parsing (pasting text already proves the pipeline), refresh-token rotation and rate limiting, query persistence, reranking / hybrid search / query rewriting (deferred until evals can prove they help), LangGraph, and deployment to Cloud Run + Vercel.

**Not there yet:** no automated test suite. Verification so far is runtime scripts and end-to-end probes; `createApp()` is already factored for supertest.

See [STATUS.md](STATUS.md) for the full milestone log, every decision with its rationale, and verified SQL for inspecting documents, chunks, and embeddings.
