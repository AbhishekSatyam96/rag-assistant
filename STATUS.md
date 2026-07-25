# RAG Knowledge Assistant — Progress Snapshot

**What it is:** A document Q&A app — upload docs → ask questions → get grounded, streamed answers with citations. Built as a **portfolio proof-piece for senior/lead roles** by a frontend-strong dev deliberately learning backend.

**Architecture (locked):** One git repo, **two standalone apps** — deliberately NOT Next.js API routes, because the goal is to show a *real* backend:

- **`api/`** — Express 5 + TypeScript (ESM), the backend.
- **`web/`** — Next.js 16 + React 19 + Tailwind v4, the frontend.

**Stack:** Express 5 · Prisma 7 (`@prisma/adapter-pg`) · Neon Postgres + **pgvector 0.8.1** · OpenAI embeddings (`text-embedding-3-small`, 1536-dim) · `@langchain/textsplitters` · `jose` (JWT) · `@node-rs/argon2` (argon2id) · `zod` 4 · Next.js App Router · pnpm.

## ✅ Completed

**M1 — Database + health**
- API ↔ Prisma ↔ Neon wired up. `User` model. `GET /health` returns `{status, users}`.

**M2 — Auth (backend)**
- `POST /auth/signup` & `POST /auth/login` → return `{ user, token }`.
- `GET /me` — protected by a `requireAuth` middleware.
- JWT (HS256, 1-hour expiry) via `jose`; passwords hashed with argon2id; input validated with `zod`.
- Layered structure: **routes → service → lib**. 9/9 end-to-end checks passed.

**M3 — Auth (frontend)**
- `src/lib/api.ts` — stateless typed `fetch` client; normalizes the API's `{ error }` shape into a thrown `ApiError`.
- `src/lib/auth-context.tsx` — token in memory + mirrored to `localStorage`; re-validates against `/me` on load.
- `src/components/AuthForm.tsx` — one shared form (`mode="login|signup"`).
- Pages: `/login`, `/signup`, protected `/me`, home. CORS enabled for the Next dev origin.

**M4 — Ingestion pipeline + HTTP surface** ✅ *complete*
- **`lib/chunk.ts`** — `chunkText()` via `RecursiveCharacterTextSplitter` (`chunkSize 1000`, `chunkOverlap 200`).
- **`lib/embed.ts`** — `embed(texts)` → `number[][]`, batched 100/req, order preserved.
- **`lib/openai.ts`**, **`lib/env.ts`** — shared client; `OPENAI_API_KEY` required at boot.
- **`document.service.ts`** — `ingestDocument()` drives `PENDING → PROCESSING → READY/FAILED`; chunks + embeds **outside** any transaction, then persists chunks + embeddings + status flip in **one** transaction. Dedupes on `(userId, contentHash)` before doing any paid work.
- **`document.schema.ts`** — zod body: `title` (trim, 1–200), `content` (trim, 1–200 000). No `userId` — ownership comes from the token only.
- **`document.routes.ts`** — `POST /documents`, `GET /documents`, `GET /documents/:id`, mounted `app.use("/documents", requireAuth, documentRouter)`.
- **`listDocuments` / `getDocument`** — explicit `select` (no `content`, no `embedding`); ownership enforced inside the `WHERE` clause.
- **Error middleware** now handles body-parser failures (413 / 400) instead of letting them fall through as 500s.
- **Verified:** 23/23 end-to-end HTTP checks against real Neon + real OpenAI. 12/12 service-level read-path checks. 12/12 schema checks. `pnpm smoke:ingest` still 12/12 in both `--fake` and live modes.

**M5 — Documents UI (frontend)** ✅ *complete*
- **`/documents`** — protected dashboard: paste form + document list, verified working in the browser (6-chunk document ingested and rendered `Ready`).
- **`components/DocumentForm.tsx`** — title + textarea, client validation mirroring the server's zod rules, live character counter against the 200 000 cap, distinct notice on a deduped ingest.
- **`components/DocumentList.tsx`** — renders all four `DocStatus` states; `STATUS_STYLE` is typed `Record<DocStatus, …>` so adding a status server-side becomes a compile error here.
- **`lib/use-require-auth.ts`** — the redirect-if-unauthenticated guard, lifted out of `/me` so protected pages share it.
- **`lib/api.ts`** — `createDocument` / `listDocuments` / `getDocument` + `DocumentSummary`.
- **Polling** — the page polls the list only while a document is non-terminal, and tears the interval down when everything is `READY`/`FAILED`.
- **Verified:** `tsc`, ESLint, `next build` clean; CORS preflight for `POST /documents` returns 204 allowing `authorization`; wire shape confirmed to be exactly `DocumentSummary` with `content` absent.

**M6 — Retrieval: streaming grounded answers + citations** ✅ *complete*
- **HNSW index** — `20260725120000_chunk_embedding_hnsw`, hand-written SQL applied with `migrate deploy`. `USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`.
- **`lib/retrieve.ts`** — embeds the question, then `$queryRaw` ordering by `embedding <=> $1::vector`, `LIMIT k`, joined to `Document` and **scoped by `userId` in the `WHERE` clause**. Sets `hnsw.ef_search = 100` and `hnsw.iterative_scan = 'strict_order'` via `SET LOCAL` inside a transaction.
- **`lib/answer.ts`** — transport-free async generator of text deltas. Numbered-source context block, `temperature: 0`, a system prompt that forbids pretraining knowledge and mandates `[n]` citations, and a fixed `REFUSAL` constant. Short-circuits with no model call when retrieval returns nothing.
- **`modules/queries/`** — `query.schema.ts` (`question` 1–1000 trimmed, `k` int 1–10 default 5), `query.service.ts` (yields a `QueryEvent` discriminated union: `sources` → `token`* → `done` | `error`), `query.routes.ts` (NDJSON), mounted `app.use("/queries", requireAuth, queryRouter)`.
- **`web/src/lib/api.ts`** — `streamAsk()`, an async generator over `fetch` + `ReadableStream` with correct NDJSON line buffering and `TextDecoder({ stream: true })`.
- **`/ask` page** + `AnswerView.tsx` (inline `[n]` → clickable chips) + `SourceList.tsx` (expandable chunk text, cosine similarity shown).
- **Verified:** 13/13 HTTP validation/auth checks · 12/12 client-stream checks incl. 1-byte adversarial chunking · 10/10 citation-parser checks · tenant isolation proven at both the service and HTTP layer · client-disconnect abort leaves no unhandled rejection · `tsc`, ESLint, `next build` all clean.

## ➡️ Next — M7: Eval harness

1. **Golden question set** — questions with known answers over a fixed corpus, committed as data.
2. **Retrieval metrics** — hit-rate@k / MRR: did the chunk containing the answer make the top k? This is what finally settles `k = 5`, `chunkSize 1000`, `chunkOverlap 200`, all currently guesses.
3. **Answer metrics** — groundedness (every claim traceable to a cited chunk) and refusal accuracy (does it refuse when it should, and *only* then). `temperature: 0` and the fixed `REFUSAL` string exist to make both measurable.
4. **A real test runner** — still none. `node:test` is the low-friction choice; `createApp()` is already factored for supertest.

**Open questions:** the demo corpus, and whether to persist queries (a `Query` table would enable history, caching, and scoring stored answers — currently answers are assembled server-side and thrown away).

## 🧠 Key decisions (and why)
- **`vector_cosine_ops` in the index, `<=>` in the query** → the operator class and the operator must agree. Verified empirically: with `enable_seqscan = off`, `<=>` plans as `Index Scan using Chunk_embedding_hnsw_idx` while `<->` (L2) still plans as `Seq Scan` + `Sort`. A mismatch never errors — it just silently stops using the index, so the symptom is "slow but correct", which survives to production.
- **HNSW, not IVFFlat** → IVFFlat learns cluster centroids from existing data, so building it on a near-empty table produces a permanently bad index. HNSW builds incrementally, which is the only option for a table that grows one upload at a time.
- **`hnsw.iterative_scan = 'strict_order'`** → an ANN index knows nothing about `userId`, so Postgres post-filters: it walks the index in distance order and *then* discards other tenants' rows. Ask for top-5 and you can get 2, or 0. Still correct, never a leak — but it silently under-returns, and it gets worse as users are added. pgvector 0.8's iterative scan keeps scanning instead of returning short. `strict_order` over `relaxed_order` so results stay in true distance order.
- **`SET LOCAL`, not `SET`** → `SET` mutates the pooled connection's session, so one query's tuning silently becomes global config for whichever request gets that connection next. `SET LOCAL` reverts on commit — which is why the read path has a transaction around it at all.
- **No distance threshold on retrieval** → semantic search always returns *something*; a cutoff would be a magic number tuned by vibes. The prompt does the refusing instead, and it was verified to work: an off-corpus question retrieves a source at similarity 0.33 and still returns the exact `REFUSAL` string.
- **A fixed `REFUSAL` constant, not "say you don't know"** → left to its own judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. A verbatim string is something the UI can detect and the eval harness can assert on.
- **`temperature: 0`** → this is grounded QA, not writing; every degree of creativity is freedom to invent. It also makes M7 meaningful — under a non-deterministic model, a regression is indistinguishable from noise.
- **Embedding model is a hardcoded constant, generation model is an env var** → changing `CHAT_MODEL` is a deploy decision; changing the embedding model invalidates every vector in the database. One belongs in config, the other must never be a flag someone can flip.
- **NDJSON over `fetch` + `ReadableStream`, not SSE** → `EventSource` cannot set request headers and auth is a Bearer token, so SSE would force the token into a query string (server logs, browser history, `Referer`). A hard constraint, not a preference. NDJSON because events have different shapes and `JSON.parse` per line is the entire client parser.
- **The service yields typed events; only the route knows about HTTP** → transport is the most likely thing to change (SSE or WebSocket if auth ever moves to cookies) and none of that should require reopening the answer logic.
- **Response headers deferred until the first event** → a response has exactly one status code and it's committed at the first byte. Generators are lazy, so `answerQuestion` hasn't run when the route starts consuming it: retrieval failures still throw while a real status is available (→ error middleware), and only post-header failures become an in-band `error` event.
- **`AbortController` wired from `res.on("close")` → OpenAI** → a closed tab otherwise leaves us streaming tokens into a dead socket, billed in full. An abort is explicitly *not* treated as an error.
- **Sources emitted before the first token** → retrieval is fast and generation is slow; sending citations first fills the screen during the part of the wait the user actually feels.
- **`n` sent explicitly on each source, not inferred from array position** → the model writes `[2]` into prose a human reads; keeping the marker in the payload means the mapping survives any future filtering or reordering of the list.
- **Citations parsed at render time from the accumulated string** → mid-stream a marker arrives as `[`, then `[1`, then `[1]`. Re-deriving each render makes a half-typed marker display as literal text and become a chip the instant it completes; incremental parsing would need explicit partial-state handling for no gain.
- **`matchAll`, never `regex.exec()` in a loop, on a module-level `/g` regex** → `exec` mutates `lastIndex` on the shared object, so state leaks between calls and every other render skips matches. Covered by a test.
- **Buffer NDJSON lines and use `TextDecoder({ stream: true })`** → a network chunk respects neither line boundaries nor UTF-8 character boundaries. Both bugs work perfectly on short ASCII answers and break on long or accented ones — the worst possible failure schedule. Verified by feeding the parser a body one byte at a time.
- **Functional `setAnswer(prev => prev + value)`** → tokens land faster than React commits; `setAnswer(answer + value)` reads a stale closure and drops characters only under speed.
- **Cosine similarity shown in the UI** → the fastest way to see *why* an answer was weak. A top hit at 0.31 means retrieval found nothing, which is a completely different bug from the model misreading a good chunk.
- **Real Express backend, not Next API routes** → to demonstrate backend skill for senior roles.
- **Token in localStorage + in-memory context** (not httpOnly cookie yet) → deliberate tradeoff; httpOnly cookies noted as the *production-hardening* step.
- **`api.ts` holds no token** → auth state lives in exactly one place (the context).
- **`jose` for JWT** → ESM/edge-native, reusable in Next.js middleware later.
- **argon2id via `@node-rs/argon2`** → prebuilt binaries, avoids node-gyp pain.
- **Chunk + embed run *outside* the DB transaction** → never hold a Postgres transaction open across a slow external API call.
- **pgvector written via raw SQL two-step** → Prisma can't set an `Unsupported("vector(1536)")` column via `createMany`; insert text columns first, then `UPDATE … = ${literal}::vector` matched by `(documentId, chunkIndex)`.
- **HNSW index kept OUT of Prisma-managed migrations** → hard-won: Prisma Migrate can't model an index on an `Unsupported()` column, so `migrate dev` sees drift and auto-generates a `DROP INDEX` every time (this corrupted history once and forced a DB reset). Add it at M6 via `migrate deploy`, which skips drift detection. `<=>` works without it at demo scale.
- **`HttpError` carries a `cause`** → wrapping an error must never destroy it. The first smoke run hid a real OpenAI 429 behind a bare `500`.
- **`ingestDocument` accepts an optional `embedFn`** → a DI seam; the smoke test passes a deterministic stub so the DB path is testable without a paid call.
- **`CREATE EXTENSION vector` lives in the migration by hand** → Prisma won't emit it, it must run before `Chunk`, and (unlike indexes) it does NOT cause drift.
- **Dedupe by `sha256(content)` before embedding** → plain sha256, no salt/KDF: the exact opposite of password hashing, for the opposite reason — here identical input *must* collide. Re-uploading the same text is the common case and embedding is the expensive step.
- **`.trim()` before `.min(1)` in zod** → order is load-bearing. `.min(1).trim()` measures the untrimmed string (`"   "` is 3 chars, passes) then trims to `""`, silently storing empty values.
- **zod `content` max (200k) sits below `express.json({ limit: "1mb" })`** → layered validation: an oversized paste gets a field-level 400; only an absurd body reaches body-parser's 413.
- **Body-parser errors mapped explicitly** → they are neither `ZodError` nor `HttpError`, so they used to fall through as `500`. Only 4xx from body-parser is trusted; a 5xx from it is a genuine server fault. The byte limit in the message is read off `err.limit` so it can't drift from the config.
- **Unknown body keys are stripped, not rejected** (zod default) → a client POSTing `status: "READY"` or `userId` has it silently dropped. Free mass-assignment protection.
- **404, not 403, for another user's document** → a 403 confirms the id exists, letting an attacker enumerate ids to map another tenant's library. Both 404s are byte-identical so the message can't become an oracle. (*IDOR / horizontal privilege escalation.*)
- **Ownership lives in the `WHERE` clause** → `findFirst({ where: { id, userId } })`, never `findUnique({ id })` + a follow-up `if`. Makes the rule structural instead of one forgotten branch away from a leak.
- **List/detail `select` omits `content`** → otherwise rendering a sidebar downloads the user's entire corpus. `error` *is* included so a `FAILED` row explains itself without an N+1.
- **`chunkCount` denormalised onto `Document`** → listing documents shouldn't need a `COUNT(*)` against `Chunk`; written inside the same transaction as the rows it counts, so it can't drift.
- **`200` (not `201`) when deduped** → `201 Created` is a lie when nothing was created. `deduped` rides along in the body so the UI can say "already in your library".
- **`POST /documents` re-reads the row and returns the same shape as `GET /:id`** → one extra cheap SELECT buys the client a single `Document` type and a polling loop with no special case for the response that started it.
- **Ingestion stays synchronous for now, but the client is written for async** → measured cost is ~4.6s live vs ~1.2s with stub embeddings; that ~3.4s is pure OpenAI round-trip, and it's the concrete argument for `202 Accepted` later. The frontend already treats the POST result as "status right now" and polls, so switching is a server-only change.
- **`requireAuth` applied at the mount point** → not per-route, so a route added later can't accidentally ship unauthenticated.
- **`currentUserId(req)` helper instead of `req.user!.id`** → if the router were ever mounted without `requireAuth`, `!` throws a `TypeError` surfacing as a confusing `500`; the helper returns an honest `401`.
- **The frontend guard is UX, not security** → `useRequireAuth` hides UI; every `/documents` route independently verifies the token, which is what actually isolates tenants.

## 📦 Current state
- **M6 is written and verified but NOT yet committed.** Last commit `8fd65ef`.
- **DB state:** 2 users · 2 documents ("Testing candid" 6 chunks, "Shri Ganesh Story" 2 chunks) · 8 chunks. Throwaway M6 test accounts were created and deleted again.
- **No secrets in git** — `.env` files are gitignored (verified).
- **No git remote configured** yet.
- Dev servers: API on `:4000` (`cd api && pnpm dev`), web on `:3000` (`cd web && pnpm dev`).
- Auth uses real signup — no seeded account; create one at `/signup` (email + password ≥ 8 chars).
- Required env: `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `OPENAI_API_KEY`, optional `CHAT_MODEL` (default `gpt-4o-mini`), `PORT`, `NODE_ENV`, `WEB_ORIGIN`.

### ⚠️ `prisma migrate dev` is now unsafe on this database
The HNSW index exists in Postgres but cannot be represented in `schema.prisma`, so `migrate dev` sees drift and will generate a `DROP INDEX` (this already corrupted migration history once). From here on, author migrations by hand or with `prisma migrate diff`, and apply them with **`prisma migrate deploy`**, which does no drift detection. `migrate status` is safe.

## 🔍 Inspecting the data in Neon

Neon console → project **rag-assistant** → branch **production** → **SQL Editor** (left sidebar). **Tables** browses rows visually but won't render the `vector` column usefully — use SQL for anything involving embeddings. All queries below are verified working.

```sql
-- Documents
SELECT id, title, status, "chunkCount", "createdAt"
FROM "Document" ORDER BY "createdAt" DESC;

-- Chunks of the newest document, with embedding sanity checks
SELECT c."chunkIndex", left(c.content, 60) AS preview, length(c.content) AS chars,
       vector_dims(c.embedding) AS dims,
       left(md5(c.embedding::text), 8) AS fingerprint  -- distinct = no mis-targeted UPDATE
FROM "Chunk" c
WHERE c."documentId" = (SELECT id FROM "Document" ORDER BY "createdAt" DESC LIMIT 1)
ORDER BY c."chunkIndex";

-- pgvector version, and the HNSW index (added in M6)
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Chunk';

-- Prove the operator class is load-bearing: <=> uses the index, <-> does not,
-- even with sequential scans disabled. (Run all four lines together.)
SET enable_seqscan = off;
EXPLAIN SELECT id FROM "Chunk"
  ORDER BY embedding <=> (SELECT embedding FROM "Chunk" LIMIT 1) LIMIT 5;  -- Index Scan
EXPLAIN SELECT id FROM "Chunk"
  ORDER BY embedding <-> (SELECT embedding FROM "Chunk" LIMIT 1) LIMIT 5;  -- Seq Scan + Sort
RESET enable_seqscan;

-- A preview of M6: cosine distance from chunk 0 to every other chunk
WITH d AS (SELECT id FROM "Document" ORDER BY "createdAt" DESC LIMIT 1),
     anchor AS (SELECT embedding FROM "Chunk"
                WHERE "documentId" = (SELECT id FROM d) AND "chunkIndex" = 0)
SELECT c."chunkIndex",
       ROUND((c.embedding <=> (SELECT embedding FROM anchor))::numeric, 4) AS cosine_distance
FROM "Chunk" c WHERE c."documentId" = (SELECT id FROM d)
ORDER BY cosine_distance ASC;
```

Note the table names are **double-quoted PascalCase** (`"Document"`, `"Chunk"`) — Prisma creates them that way, so unquoted `document` will not resolve.

## 🚧 Not built yet (deliberately deferred)
- **File upload / parser path** (file → text). Deliberately skipped: pasting text already proves the pipeline, and `pdf-parse` demonstrates nothing about engineering judgement.
- **Auth hardening:** refresh-token rotation, server-side logout/revocation, rate limiting on `/auth/*`, `helmet` headers.
- **Eval harness** (M7, next — golden question set, retrieval hit-rate).
- **Query persistence** — answers are assembled server-side (`done.answer`) then discarded. A `Query` table would unlock history, caching, and scoring stored answers.
- **Markdown rendering of answers** — the model emits markdown; `/ask` renders it as preformatted text. Rendering it properly means sanitising it, since the text derives from user-supplied documents.
- **Reranking** (cross-encoder over the top-k), **hybrid search** (BM25 + vector), **query rewriting** — the standard retrieval-quality ladder, all deliberately deferred until M7 can prove they help.
- **LangGraph agentic flow.**
- **Deploy:** Dockerize → Cloud Run + Vercel, CI, README as a system-design doc.
- **Tests:** no automated test suite yet — verification so far is runtime scripts (`pnpm smoke:ingest`) and throwaway probes. `createApp()` is already factored for supertest.
- **Pagination** on `GET /documents` — `listDocuments` takes an object param specifically to make adding `cursor`/`take` non-breaking.

**Planned order:** ~~ingestion~~ → retrieval → eval → LangGraph → deploy.
