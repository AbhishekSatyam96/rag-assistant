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

## ➡️ Next — M6: Retrieval (streaming answers + citations)

1. **HNSW index — now due.** The deliberately deferred one. Raw SQL migration applied with `migrate deploy` (never `migrate dev` — see Key decisions), using `vector_cosine_ops`.
2. **`lib/retrieve.ts`** — embed the question, then `$queryRaw` ordering by `embedding <=> $1::vector`, `LIMIT k`, **scoped by `userId`**. Highest-risk code in the app: it's raw SQL, so Prisma's types won't catch a missing tenant scope.
3. **Answer generation** — retrieved chunks as context, a prompt that forbids ungrounded claims, and a real refusal path when the context doesn't contain the answer.
4. **Citations** — map answers back to `(documentId, chunkIndex)`. This is what `chunkIndex` exists for.
5. **UI** — ask box, streamed answer, source chips.

**Decisions to make, with current leanings:**
- **Cosine (`<=>`)**, not L2 — OpenAI embeddings are normalized. The index must use `vector_cosine_ops` or Postgres silently won't use it.
- **top-k = 5** to start; let the eval harness argue it up or down rather than guessing now.
- **`fetch` + `ReadableStream`, not `EventSource`/SSE** — `EventSource` cannot send an `Authorization` header, and auth is a Bearer token. This is a hard constraint, not a preference.

## 🧠 Key decisions (and why)
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
- **Working tree clean.** Last commit `be4729a` ("UI and functionality of document page"). M4 + M5 are fully committed.
- **DB state:** 2 users · 1 document ("Testing candid", `READY`, 6 chunks) · 6 chunks, every embedding 1536-dim and distinct.
- **No secrets in git** — `.env` files are gitignored (verified).
- **No git remote configured** yet.
- Dev servers: API on `:4000` (`cd api && pnpm dev`), web on `:3000` (`cd web && pnpm dev`).
- Auth uses real signup — no seeded account; create one at `/signup` (email + password ≥ 8 chars).
- Required env: `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `OPENAI_API_KEY`, optional `PORT`, `NODE_ENV`, `WEB_ORIGIN`.

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

-- pgvector version, and confirmation the HNSW index is still absent
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
SELECT indexname FROM pg_indexes WHERE tablename = 'Chunk';

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
- **Retrieval endpoint** (M6, next).
- **Eval harness** (golden question set, retrieval hit-rate).
- **LangGraph agentic flow.**
- **Deploy:** Dockerize → Cloud Run + Vercel, CI, README as a system-design doc.
- **Tests:** no automated test suite yet — verification so far is runtime scripts (`pnpm smoke:ingest`) and throwaway probes. `createApp()` is already factored for supertest.
- **Pagination** on `GET /documents` — `listDocuments` takes an object param specifically to make adding `cursor`/`take` non-breaking.

**Planned order:** ~~ingestion~~ → retrieval → eval → LangGraph → deploy.
