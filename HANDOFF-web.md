# RAG Knowledge Assistant — `web/` (frontend) build handoff

**Read this first if you're starting the frontend.** The backend (`api/`) is built and its auth is done + tested. Your job this session is to scaffold `web/` (Next.js) and wire login/signup to the API.

---

## Who I am / how to work with me
Frontend-strong full-stack dev **learning backend**, building this RAG Knowledge Assistant as a **portfolio proof-piece for senior/lead roles**. Guide me **step by step and teach as you build** — bridge new ideas from **frontend concepts I already know**, default to **TypeScript**, and be **candid**: give a clear recommendation with the runner-up + its tradeoff, not an exhaustive survey. Verify things actually work (run them) rather than asserting.

## What this project is
Document Q&A app: upload docs → ask questions → grounded, streamed answers with citations.

**Architecture (locked):** one git repo, two standalone apps:
- `api/` — Express 5 + TypeScript backend (the real backend, deliberately NOT Next.js API routes). **Built through auth.**
- `web/` — Next.js frontend. **This is what we're building now** (currently an empty folder).

Deploy later: API on Cloud Run, web on Vercel/Cloud Run, CI, README as a system-design doc.

---

## The backend is already running-ready

**Start it** (separate terminal, from `api/`):
```bash
cd api && pnpm dev          # → API on http://localhost:4000
```
- Base URL: **`http://localhost:4000`** (env `PORT`, default 4000).
- DB is Neon Postgres (free tier **scales to zero** → the *first* request after it's been idle can be slow or need one retry; it's not your bug).
- Health check to confirm it's alive: `GET /health` → `{"status":"ok","users":<n>}`.

---

## API auth contract (this is the important part)

All request/response bodies are JSON. Send `Content-Type: application/json`.

### `POST /auth/signup`
Request:
```json
{ "email": "user@example.com", "password": "min-8-chars" }
```
Success — **201**:
```json
{
  "user":  { "id": "uuid", "email": "user@example.com" },
  "token": "eyJhbGciOiJIUzI1NiJ9...."
}
```

### `POST /auth/login`
Request: same shape as signup. Success — **200**: same `{ user, token }` shape.

### `GET /me`  (protected — the pattern every future protected route uses)
Send the token:
```
Authorization: Bearer <token>
```
Success — **200**:
```json
{ "user": { "id": "uuid", "email": "user@example.com" } }
```

### Validation rules (enforced server-side by zod)
- `email` — must be a valid email.
- `password` — **min 8 characters**.
Mirror these on the client for UX, but the server is the source of truth.

### Error responses (consistent shape: `{ "error": string, ... }`)
| Status | When | Body |
|---|---|---|
| **400** | Body fails validation | `{ "error": "ValidationError", "details": [ ...zod issues... ] }` |
| **401** | Wrong email/password on login | `{ "error": "Invalid email or password" }` |
| **401** | Missing/badly-formed `Authorization` header | `{ "error": "Missing or malformed Authorization header" }` |
| **401** | Token invalid / tampered / expired | `{ "error": "Invalid or expired token" }` |
| **409** | Signup with an email that already exists | `{ "error": "Email already registered" }` |
| **500** | Unexpected server error | `{ "error": "Internal Server Error" }` |

The `400` `details` array is raw zod issues (each has `path`, `message`, `code`). Fine to surface `message` per field, or just show a generic "check your input."

### About the token
- JWT, **HS256**, **expires in 1 hour**. Claims: `sub` (= user id), `email`, `iat`, `exp`.
- It's **signed, not encrypted** — readable by anyone (don't treat it as secret storage), but unforgeable without the server secret.
- There is **no refresh token yet** (see "Not built yet" below). On expiry, the user simply logs in again. Plan the UI so a 401 on any protected call bounces the user to `/login`.

---

## Gotchas you'll hit immediately (in order)

1. **CORS is NOT enabled on the API yet.** The moment `web/` (e.g. `http://localhost:3000`) calls `http://localhost:4000`, the browser will block it (different origin). This is a **backend change**, not a frontend one — the fix lives in `api/`:
   ```ts
   // api/src/app.ts — add near the top of createApp()
   import cors from "cors";
   app.use(cors({ origin: "http://localhost:3000", credentials: true }));
   ```
   (`pnpm add cors @types/cors` in `api/`.) **Ask the API side to add this first**, or you'll spend an hour thinking your fetch code is broken when it isn't. `credentials: true` only matters if you go the cookie route (below).

2. **Where to store the token — decide deliberately, it's a real tradeoff:**
   - **localStorage** — dead simple, works with the current API as-is (token comes back in the JSON body; you save it and attach `Authorization: Bearer`). Downside: readable by any XSS-injected script.
   - **httpOnly cookie** — not readable by JS, so safer against XSS. But it needs an **API change** (the server must `Set-Cookie` instead of / in addition to returning the token in the body), plus CSRF thinking. More correct, more work.
   - **Recommendation:** start with the token in memory (React context/store) + `localStorage` to survive refresh, so you can build the whole flow against the API *unchanged*. Note in the README that httpOnly cookies are the production-hardening step — that "I know the tradeoff and chose deliberately" note is itself a senior signal. Revisit once the flow works end to end.

3. **Neon cold start** (see above) — first call after idle may lag ~1–2s. Don't mistake it for a hang.

---

## Suggested `web/` starting point (confirm with me before scaffolding)
- **Next.js (App Router) + TypeScript**, matching the api's TS/ESM world.
- A tiny typed **API client** (`web/src/lib/api.ts`) that wraps `fetch`, sets the base URL from `NEXT_PUBLIC_API_URL`, attaches the Bearer token, and normalizes the `{ error }` response shape into thrown errors — so components stay clean. (Same instinct as the api's thin-route / service split, just on the client.)
- Pages: `/signup`, `/login`, and one **protected** page that calls `GET /me` to prove the whole loop works — the frontend mirror of the backend's `/me` smoke test.
- Env: `NEXT_PUBLIC_API_URL=http://localhost:4000` in `web/.env.local`.

Keep it to **that vertical slice first** (signup → login → see `/me`), same as we did on the backend. Ingestion/upload UI comes later.

---

## Backend status, for reference

**Done:**
- M1 — API ↔ Prisma 7 (`@prisma/adapter-pg`) ↔ Neon Postgres. `User` model, `GET /health`.
- M2 — Auth. `@node-rs/argon2` (argon2id) hashing, `jose` JWTs, `zod` validation. Layered structure: routes → service → lib. `requireAuth` middleware guards routes. 9/9 end-to-end checks pass.

**Not built yet (so the frontend must not assume these exist):**
- Refresh-token rotation, logout/revocation, rate limiting on `/auth/*`, `helmet` security headers, and — importantly — **CORS** (see gotcha #1).

**After the frontend auth slice, the roadmap continues on the backend:** ingestion (pgvector: upload → chunk → embed → store; *document corpus still to be chosen*) → retrieval endpoint (streaming answers + citations) → eval harness → LangGraph agentic flow → Dockerize + Cloud Run + CI.

---

**Start by confirming the `web/` stack choice with me, then scaffold the signup→login→`/me` slice.** And flag CORS to the API side early.
