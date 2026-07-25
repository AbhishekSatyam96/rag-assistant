# RAG Knowledge Assistant — Progress Snapshot

**What it is:** A document Q&A app — upload docs → ask questions → get grounded, streamed answers with citations. Built as a **portfolio proof-piece for senior/lead roles** by a frontend-strong dev deliberately learning backend.

**Architecture (locked):** One git repo, **two standalone apps** — deliberately NOT Next.js API routes, because the goal is to show a *real* backend:

- **`api/`** — Express 5 + TypeScript (ESM), the backend.
- **`web/`** — Next.js 16 + React 19 + Tailwind v4, the frontend.

**Stack:** Express 5 · Prisma 7 (`@prisma/adapter-pg`) · Neon Postgres + **pgvector** · OpenAI embeddings (`text-embedding-3-small`, 1536-dim) · `@langchain/textsplitters` · `jose` (JWT) · `@node-rs/argon2` (argon2id) · `zod` · Next.js App Router · pnpm.

## ✅ Completed

**M1 — Database + health**
- API ↔ Prisma ↔ Neon wired up. `User` model. `GET /health` returns `{status, users}`.

**M2 — Auth (backend)**
- `POST /auth/signup` & `POST /auth/login` → return `{ user, token }`.
- `GET /me` — protected by a `requireAuth` middleware.
- JWT (HS256, 1-hour expiry) via `jose`; passwords hashed with argon2id; input validated with `zod`.
- Layered structure: **routes → service → lib**. 9/9 end-to-end checks passed.

**M3 — Auth (frontend)** ← done this session
- `web/` scaffolded: Next.js App Router, TypeScript, Tailwind v4, `src/` dir.
- **`src/lib/api.ts`** — stateless typed `fetch` client; normalizes the API's `{ error }` shape into a thrown `ApiError`.
- **`src/lib/auth-context.tsx`** — `AuthProvider`: token held in memory + mirrored to `localStorage`; on load it re-validates the token by calling `/me`; exposes `login` / `signup` / `logout`.
- **`src/components/AuthForm.tsx`** — one shared form (`mode="login|signup"`), client-side validation mirroring the server's zod rules.
- **Pages:** `/login`, `/signup`, protected `/me`, and a home page.
- **CORS** enabled on the API (`api/src/app.ts`) for the Next dev origin.
- **Verified end-to-end:** CORS preflight `204`; signup/login/`me` `201/200/200`; bad token `401`; `tsc` + ESLint clean; all routes serve `200`.

## 🔨 In progress — M4: Ingestion pipeline (backend) ← this session

**DB layer is live and migrated. Service is code-complete + typechecks, but not yet run** (no real DB/OpenAI call made — no routes, no data).

- **`api/src/lib/chunk.ts`** — `chunkText(text, opts)` using `RecursiveCharacterTextSplitter` (defaults: `chunkSize 1000`, `chunkOverlap 200`); trims + drops empty chunks; returns `{ content, chunkIndex }[]`.
- **`api/src/lib/embed.ts`** — `embed(texts)` → `number[][]` via OpenAI, batched (100/req), output kept aligned to input order.
- **`api/src/lib/openai.ts`** — single shared OpenAI client, keyed off validated env.
- **`api/src/lib/env.ts`** — now requires `OPENAI_API_KEY` (fails fast at boot).
- **`api/src/modules/documents/document.service.ts`** — `ingestDocument()`: creates a `Document`, drives the `PENDING → PROCESSING → READY/FAILED` state machine, chunks + embeds **outside** any transaction, then persists chunks + embeddings + status flip in **one** transaction.
- **Schema:** `Document` + `Chunk` models (+ `DocStatus` enum) now have a migration; fixed a missing `User.documents` back-relation.
- **Migration APPLIED & clean:** `prisma/migrations/20260724105907_add_documents_and_chunks/` — enables pgvector, creates `Document`/`Chunk`/`DocStatus` + FKs + `documentId` index. `migrate status` = "up to date", no drift. Verified live: `vector` 0.8.1 enabled, tables present.
- **⚠️ HNSW index deferred on purpose** — see the pgvector/Prisma-Migrate note in Key decisions. To be added at the retrieval milestone via `migrate deploy`.
- **DB was reset once** to clean up a corrupted migration history (my HNSW-in-migration mistake). All prior test users were wiped — **re-signup needed** to get an account.

**➡️ Immediate next action:** build the routes/schema to expose `ingestDocument` over HTTP (matches the `auth` module's routes → service → lib layering), OR a smoke test that ingests one short doc end-to-end (first real OpenAI + DB call).

**Still needed to call M4 done:** parser/upload path (file → text) · HTTP routes · runtime smoke test · (later) HNSW index.

## 🧠 Key decisions (and why)
- **Real Express backend, not Next API routes** → to demonstrate backend skill for senior roles.
- **Token in localStorage + in-memory context** (not httpOnly cookie yet) → deliberate tradeoff: simplest thing that works against the API unchanged. httpOnly cookies noted as the *production-hardening* step.
- **`api.ts` holds no token** → auth state lives in exactly one place (the context), keeping the client pure and reusable.
- **`jose` for JWT** → ESM/edge-native, so token-verify logic can be reused in Next.js middleware later.
- **argon2id via `@node-rs/argon2`** → prebuilt binaries, avoids node-gyp build pain.
- **Chunk + embed run *outside* the DB transaction** → embedding is a network call to OpenAI; never hold a Postgres transaction open across a slow external call.
- **pgvector written via raw SQL two-step** → Prisma can't set the `Unsupported("vector(1536)")` column through `createMany`, so we insert text columns first, then `UPDATE ... = ${literal}::vector` matched by `(documentId, chunkIndex)`.
- **HNSW index kept OUT of Prisma-managed migrations** → hard-won lesson: Prisma Migrate can't model an index on an `Unsupported()` column, so `migrate dev` sees it as drift and auto-generates a `DROP INDEX` every time (this corrupted the history once and forced a reset). Plan: add the HNSW/cosine index at the retrieval milestone via a raw migration applied with `migrate deploy` (which skips drift detection). pgvector's `<=>` search works without it at demo scale.
- **`CREATE EXTENSION vector` lives in the migration by hand** → Prisma won't emit it, it must run before the `Chunk` table, and (unlike indexes) it does NOT cause drift, so it's safe there.

## 📦 Current state
- **Working tree is NOT clean** — M4 code + the clean migration are uncommitted; last commit is still the auth work. (Note: two dead migration folders — `20260724094910` + `20260724103914_first` — were deleted this session and show as `D` in git; the new clean migration is `20260724105907`.)
- **DB freshly reset** — 0 users / 0 documents / 0 chunks. Create an account at `/signup` before testing anything auth-gated.
- New dependency: `openai` (`^6`). New required env var: **`OPENAI_API_KEY`** (already added to `api/.env`).
- **No secrets in git** — `.env` files are gitignored (verified).
- **No git remote configured** yet.
- Dev servers run locally: API on `:4000` (`cd api && pnpm dev`), web on `:3000` (`cd web && pnpm dev`).
- Auth uses real signup — there is no seeded account; create one at `/signup` (email + password ≥ 8 chars).

## 🚧 Not built yet (deliberately deferred)
- **Auth hardening:** refresh-token rotation, server-side logout/revocation, rate limiting on `/auth/*`, `helmet` security headers.
- **Ingestion pipeline** — core service is drafted (see *In progress* above), but **upload/file-parsing path and HTTP routes are not built**, and the **document corpus is not yet chosen**.
- **Retrieval endpoint** (streaming answers + citations).
- **Eval harness** (golden question set, retrieval hit-rate).
- **LangGraph agentic flow.**
- **Deploy:** Dockerize → Cloud Run + Vercel, CI, README as a system-design doc.
- **Frontend:** no upload/query UI, no tests yet.

**Planned order:** ingestion → retrieval → eval → LangGraph → deploy.
