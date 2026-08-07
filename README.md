# RAG Knowledge Assistant

Upload your documents, ask questions about them, and get **streamed answers grounded in your own text with inline citations** — plus an honest refusal when your documents don't contain the answer. Ask one question, or hold a conversation and keep asking follow-ups. Type it, or say it and have the answer read back.

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
- **Follow-ups work.** Ask "how long is it?" after a question about parental leave and it searches for the right thing — a follow-up is rewritten into a standalone query before it is ever embedded. Say "make that shorter" and it skips retrieval entirely and reworks the answer it already gave you.
- **Ask out loud, listen to the answer.** Hold the mic button, speak, and the transcript lands in the box for you to check before it is sent — a misheard word becomes a visible typo instead of a silent retrieval failure. Turn on read-aloud and answers are spoken sentence by sentence as they stream, without waiting for the last token.
- **Your documents are yours.** Every query is scoped to the signed-in user at the database level.

## How it works

```
┌────────────────────────┐        ┌────────────────────────┐        ┌──────────────────┐
│ rag.abhisheksatyam.com │  JSON  │ api.abhisheksatyam.com │        │  Neon Postgres   │
│   Next.js 16 · Vercel  │ ─────► │   Express 5 · Vercel   │ ─────► │   + pgvector     │
│                        │ ◄───── │                        │ ◄───── │   (HNSW index)   │
│ /documents             │ NDJSON │ auth · documents       │        └──────────────────┘
│ /ask   (one question)  │ stream │ queries    (single)    │        ┌──────────────────┐
│ /chat  (a thread)      │        │ conversations (multi)  │ ─────► │     OpenAI       │
│                        │ audio  │ transcriptions (voice) │        │ embeddings · LLM │
└────────────────────────┘        └────────────────────────┘        │ transcription    │
                                                                    └──────────────────┘
```

Speech synthesis is absent from that diagram on purpose: reading an answer aloud never leaves the browser.

**Ingestion.** A document is hashed, split into overlapping chunks, embedded in batches, and written in a single transaction that inserts the chunks and flips the document to `READY` together. Embedding happens *outside* the transaction — a Postgres transaction is never held open across a slow third-party API call. Re-uploading identical text costs nothing and is deduped by the database.

**Retrieval.** The question is embedded, matched against the caller's chunks by approximate-nearest-neighbour search, and the top passages become a numbered context block for the model at temperature 0. Sources are streamed **before** the first token: retrieval is fast and generation is slow, so the citations fill the part of the wait the user actually feels.

**Conversation.** A follow-up is not a search query — "how long is it?" embeds to a vector about pronouns and duration, matching nothing. So a follow-up is first rewritten against the thread's history into a standalone question, and *that* is what gets embedded. Some follow-ups aren't questions at all: "make that shorter" is an instruction about the answer, and those skip retrieval entirely and re-ground on the previous turn's sources. The rewrite is shown in the UI rather than hidden, because a bad rewrite and bad retrieval look identical from the outside and have completely different fixes.

**Voice.** Both halves sit *outside* the pipeline above, and that is the design rather than an implementation detail. A recording is uploaded to `POST /transcriptions`, comes back as text, and lands in the composer — the question that follows is byte-identical to a typed one, so retrieval and generation cannot tell which you used. Reading aloud consumes an answer that has already been produced. Nothing about voice is stored on either side: there is no recordings table and there should not be one.

The two halves are deliberately asymmetric. Input uses a paid transcription model; output uses the browser's own speech synthesis. A wrong transcript changes *which passages are retrieved*, so input quality changes the result — a synthetic voice reading a correct answer is still a correct answer. Money goes where an error changes the outcome, and the output half consequently adds no endpoint, no rate limiter and no cost to a publicly shared link.

**Two surfaces, one engine.** `/ask` is single-turn and stateless; `/chat` persists threads and adds the rewrite step. They share the same retrieval, prompt and generation code — `/ask` stays deliberately unchanged because it is the path the evaluation harness scores, and a measurement target that moves underneath the measurement is worthless.

Built deliberately as a real Express backend rather than Next.js API routes — the point was to build and defend a backend, not to let a framework manage one.

## Stack

| Layer | Choice |
|---|---|
| API | Express 5 + TypeScript (ESM) |
| ORM | Prisma 7, with raw SQL where pgvector needs it |
| Database | Neon Postgres + pgvector 0.8, HNSW index |
| Embeddings | `text-embedding-3-small` (1536-dim) |
| Generation | `gpt-4o-mini` by default, configurable |
| Transcription | `gpt-4o-mini-transcribe` (voice input) |
| Speech | the browser's own `speechSynthesis` — no server, no cost |
| Auth | JWT (HS256) via `jose` + argon2id password hashing |
| Web | Next.js 16 · React 19 · Tailwind v4 |
| Hosting | Two Vercel projects from one repo |

---

## A few decisions worth defending

The full set lives in the design docs below — each is also written into the code it governs. The ones that were worth the argument:

- **HNSW, not IVFFlat.** IVFFlat learns cluster centroids from existing data, so building it on a near-empty table produces a permanently bad index. HNSW builds incrementally — the only real option for a table that grows one upload at a time.

- **The index operator class and the query operator have to agree.** `vector_cosine_ops` in the index, `<=>` in the query. A mismatch never raises an error; it just silently stops using the index. The symptom is "slow but correct", which is exactly the kind of bug that survives all the way to production. Verified with `enable_seqscan = off` that `<=>` really plans as an index scan.

- **`404`, not `403`, for another user's document.** A `403` confirms the id exists, which lets someone enumerate ids to map another tenant's library. Both 404s are byte-identical so the message can't become an oracle. Ownership lives in the `WHERE` clause — never a lookup followed by an `if`.

- **NDJSON, not SSE.** `EventSource` can't set request headers, and auth is a Bearer token — SSE would force the token into the query string, where it lands in server logs, browser history, and `Referer`. That's a constraint, not a preference.

- **A fixed refusal string, not "say you don't know."** Left to its own judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. A verbatim constant is something the UI can detect and an eval harness can assert on.

- **`trust proxy` is a hop count, never `true`.** Unset, the rate limiter sees the platform's edge and the entire internet shares one bucket. Set to `true`, Express trusts the whole `X-Forwarded-For` chain — and since anyone can send that header, an attacker mints a fresh unlimited bucket per request.

- **Conversation history comes from the database, never from the client.** A browser that posts its own transcript can fabricate an *assistant* turn — the slot in the prompt a model trusts most. History is loaded server-side from rows the caller owns, for the same reason `userId` has never been a field in a request body.

- **A transcript goes into the input box, not into a search.** Chaining recording straight to asking saves a round trip and destroys the only moment where a mishearing is visible. "Parental leaf" retrieves nothing, the grounded prompt correctly refuses, and the user watches a working system deny something their document plainly says. Same shape as the follow-up problem: every component behaved as designed, and the symptom is nowhere near the cause.

- **Content-type is a claim; magic bytes are evidence — for audio too.** `file.mimetype` is copied from a header the client wrote. The leading-bytes check is the actual gate, and here it does a second job: OpenAI picks its demuxer from the *filename extension*, and browsers disagree about what they record (Chrome gives WebM, Safari gives MP4). So the client sends bytes with no name at all and the server decides what to call the file — otherwise a Safari recording mislabelled `.webm` fails inside the paid call for something knowable for free.

- **A request limit does not bound minutes of audio.** Every other paid route costs roughly a fixed amount per call, so counting calls bounds spend. Transcription is billed by duration, so one permitted request can cost whatever the caller makes it. Counting is half the control: the browser stops recording after a minute and the upload is byte-capped *first*, and only then do per-minute, per-day and global limits mean anything. The byte cap is an imperfect proxy for duration and is documented as one — the codec decides how many seconds fit in a megabyte.

- **Citations are snapshotted onto the message, not foreign-keyed to the chunk.** Chunks are deleted when a document is deleted and recreated with new ids on every re-ingest, so a reference would make old answers lose their citations (`Cascade`) or dangle (`SetNull`). A citation is a claim about what the answer was built from *at the time it was given*, and the honest representation of that is a copy. The cost — duplicated chunk text, and no join to ask "what gets cited most" — is real and accepted.

## Design docs

This started as an exercise in designing a system properly, not just shipping one. Both mark **built** vs **degraded** vs **designed-not-built** explicitly, including the known gaps.

- **[High-Level Design](docs/hld.md)** — topology, capacity, failure modes, blast radius, and the scaling ladder.
- **[Low-Level Design](docs/lld.md)** — data model, state machines, sequence diagrams, API contracts, concurrency and idempotency semantics.

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

There's no seeded account — sign up at `/signup`, add a document at `/documents`, then ask about it at `/chat` (a thread you can follow up in) or `/ask` (one question at a time).

Voice needs no extra configuration — the transcription model is a constant, not an environment variable, because there is one deployment and no second transcriber to switch to. The microphone does need a secure context: `localhost` counts, a LAN IP does not, so testing voice from a phone on the same network means a tunnel rather than `http://192.168.x.x:3000`.

### Tests

```bash
cd api
pnpm test                   # type-check, then the unit + HTTP suite
```

No database, no network, no spend — everything asserted resolves before the first query. Env comes from a committed `.env.test` of deliberately fake values, because `env.ts` validates at import time and would otherwise refuse to boot. Type-checking runs first on purpose: `tsx` strips types without checking them, so test files are the one place where a type error can reach runtime.

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
    lib/             # chunk · embed · retrieve · answer · condense · pdf · jwt · env
                     # audio · transcribe (voice input)
                     # ndjson-stream (the one lib file that knows about HTTP)
    middleware/      # requireAuth · rate limiting · concurrency · errorHandler
    modules/         # auth · documents · queries · conversations · transcriptions
                     #   (routes → service → lib)
web/
  src/
    app/             # /login /signup /me /documents /ask /chat /chat/[id]
    components/      # AuthForm · DocumentForm/List · AnswerView · SourceList
                     # ChatView · ChatComposer · ChatTurn · ConversationList
    lib/             # api client · ndjson reader · citations · auth context
                     # speech (the spoken projection) · use-speech · use-recorder
```

Backend layering is **routes → service → lib**: routes validate input and choose a status code, services hold orchestration, lib holds transport-free logic. Both answer services yield typed events and never touch `res` — only the route knows about HTTP, so swapping NDJSON for SSE or WebSockets wouldn't reopen the answer logic.

`queries` and `conversations` are siblings rather than one generalised module. They share every primitive that matters (`retrieve`, `answer`, `condense`, the NDJSON writer) and duplicate about ten lines of orchestration — a trade made on purpose, because folding history, preset sources and persistence into the single-turn service would turn one readable function into one with three modes.

---

## Status

**Working today, deployed and verified end to end:** auth, document ingestion (paste or PDF), the documents dashboard, vector retrieval, and streamed grounded answers with citations — including that streaming really streams, and that an off-corpus question still refuses.

**Multi-turn chat**, verified manually against a real database and a real model: a pronoun follow-up gets rewritten into a standalone query before retrieval, a reformat instruction skips retrieval and keeps its citations, and another user's thread answers `404` on read, write and delete alike. Those checks were run by hand, not by a suite — see the honesty note below.

**Voice input and output**, wired into both `/ask` and `/chat`. Rejections that happen before the paid call — no file, a recording too short to hold speech, bytes that aren't audio, an upload over the cap — are covered by the HTTP suite, and the container sniffing has unit tests of its own. What is *not* covered is noted below.

Because the app spends real money on behalf of anyone who signs up, every route that generates an answer carries per-user burst and daily limits, a global daily ceiling, and a shared cap on concurrent streams — a rate limit bounds requests per window, not simultaneous in-flight generations. The concurrency cap is one counter across both `/queries` and `/conversations`, because three separate instances of a limit of 2 is a limit of 6. Counters live in Redis so they hold across instances.

Transcription gets its own three limiters rather than borrowing the answer ones, in the same burst / per-user / global shape but with different numbers. Sharing them would have been the smaller change and is wrong in both directions at once: a spent question budget would silently disable the microphone, and someone who never submits a question could transcribe all day against a counter nothing else decrements. The concurrency cap is deliberately *not* applied — it exists to bound simultaneous streams holding a resource open for seconds, and a transcription is a short request that would only compete for slots with the answers it is trying to ask for.

**In progress — an evaluation harness:** a golden question set with retrieval hit-rate@k / MRR, groundedness, and refusal accuracy, to settle the numbers currently chosen by judgement (`k`, chunk size, chunk overlap). Temperature 0 and the fixed refusal string are what make those metrics measurable in the first place.

Built so far: a unit + HTTP suite that runs with no database and no network, and a reproducible eval corpus built from this repo's own documentation — chosen because pretraining contamination is what quietly invalidates a RAG eval. If the model already knows the answer, hit-rate can be zero and the answer still looks right.

That corpus has already produced one result. Rendering the same document at two page densities and chunking both shows the short-page rendering collapsing to **exactly one chunk per page** — the chars-per-page and chars-per-chunk distributions come out identical, which means `chunkSize: 1000` never applies at all, because the page boundary decides every split before it. The median chunk drops from just under the configured ceiling to well below half of it, and a substantial minority land under 300 characters. The merge pass that would fix it needs a page *range* on `Chunk`, so it stays unbuilt until hit-rate says the damage is real.

(Exact counts deliberately aren't quoted here. This README is itself one of the corpus documents, so any figure printed in it changes the thing it measures — run `pnpm eval:inspect` for current numbers. Earlier revisions of this paragraph *did* quote a median and a percentage, and both were stale within two commits while the sentence around them still read as current. The structural claim — one chunk per page, identical distributions — has survived every rebuild.)

Still to come in this milestone: the golden set itself, and every metric above. **No accuracy or quality number is claimed anywhere in this repo yet, because none has been measured.**

**Voice is unevaluated too, and it is unevaluated in the way that matters most.** Transcription sits *upstream of everything*: a mishearing produces a well-formed question that retrieves the wrong passages, or none, with nothing anywhere to mark it as a bad input. Keeping speech outside the pipeline is what stops it contaminating the existing measurements — the request reaching `/queries` is identical whether it was typed or spoken — but that is containment, not measurement. The comparison that would settle it is hit-rate on transcribed questions against the same measure on the typed originals. Until it exists, the honest claim is that voice is an input *method*, not an accurate one.

The spoken projection of an answer — stripping citation markers and formatting, buffering the token stream into whole sentences — is pure, deterministic logic and has **no committed test**, because the web package still has no test runner at all. That is the same gap that already leaves the citation parser uncovered. It was checked by driving a simulated token stream through it, which found a real defect (the sentence segmenter breaking after abbreviations like "e.g.", producing a pause mid-sentence); that was fixed, and a fix proven by a script that no longer exists is a weaker claim than one proven by a suite that runs on every commit.

That applies most sharply to the newest feature. Chat inserts a rewrite step *upstream of retrieval*, which means hit-rate@k now measures "retrieval" on `/ask` and "rewrite + retrieval" on `/chat`. The golden set is single-turn and still scores `/ask` cleanly — turn one skips the rewriter entirely — but the rewriter has no evaluation of its own yet. The honest comparison, once the harness exists, is hit-rate on the rewritten query against hit-rate on the raw follow-up over a handful of multi-turn cases; that difference *is* the justification for the extra call and the extra latency. Until then the examples above are demonstrations, not measurements. The chat module also has no automated tests: its pure functions are cheap to cover and its persistence path needs the integration tier that doesn't exist yet.

**Deliberately deferred:** OCR for scanned PDFs (they're detected and rejected with a specific error), refresh-token rotation, per-user dollar metering, persisting the rewritten query alongside each answer (it's shown live and lost on reload), and reranking / hybrid search — held until evals can prove they help.

**Rejected rather than deferred: realtime speech-to-speech.** A continuous spoken conversation is the version of this feature people picture, and three things rule it out. Vercel functions don't hold long-lived socket connections, so retrieval would have to be called back into from inside the model's own session — at which point the grounded prompt, the fixed refusal string and `temperature: 0` stop being what produces the answer. Audio is billed per minute against an open signup, and one WebRTC session is a single request that can burn minutes for as long as a tab stays open, which no request-counting limit bounds. And citations don't survive being spoken: the numbered markers *are* the product, and reading them aloud is either noise or nothing.

*Query rewriting was on this list until chat needed it. It shipped because multi-turn is unusable without it, not because a measurement said it helps — which is exactly the kind of thing the harness exists to check after the fact.*
