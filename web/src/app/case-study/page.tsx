import type { Metadata } from "next";
import { AUTHOR, LINKS } from "@/lib/site";
import { Badge, Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import {
  IconAlert,
  IconArrowRight,
  IconChat,
  IconExternal,
  IconFile,
  IconLayers,
  IconMail,
  IconQuote,
  IconSearch,
  IconSpark,
} from "@/components/icons";

// The written half of the project: what it does, how it is put together, and
// the reasoning behind the calls that were actually hard.
//
// It exists because the source repository is private. That trade was made
// deliberately — the code is the cheap half of this project and the reasoning
// is the expensive half, so the reasoning is what gets published. What is NOT
// here is equally deliberate: no full data model, no API contracts, no capacity
// tables. This is a case study, not a blueprint someone can build from.
//
// A Server Component with no interactivity at all, so it ships as HTML and
// costs nothing in JS. Header, footer and theming come from AppShell.

export const metadata: Metadata = {
  title: "Case study",
  description:
    "How the RAG Knowledge Assistant is built: architecture, the decisions worth defending, why a follow-up question breaks retrieval, why voice sits outside the pipeline, and what was deliberately left out.",
};

// ---------------------------------------------------------------------------
// Content lives in data, not JSX
//
// Same pattern as the landing page. Prose in arrays means editing a sentence
// never risks breaking markup, and it keeps apostrophes out of JSX text where
// they would need escaping.
// ---------------------------------------------------------------------------

const FACTS = [
  { label: "Role", value: "Sole designer, engineer and operator" },
  { label: "Surface", value: "Express 5 API · Next.js 16 web app" },
  { label: "Data", value: "Neon Postgres + pgvector, HNSW index" },
  {
    label: "Model",
    value: "text-embedding-3-small · gpt-4o-mini · gpt-4o-mini-transcribe",
  },
] as const;

const PIPELINE = [
  {
    icon: <IconFile className="size-4" />,
    step: "Ingest",
    body: "A document is hashed, split into overlapping chunks, and embedded in batches. Re-uploading identical text is deduplicated by the database rather than by application logic, so two concurrent uploads of the same file cannot race.",
  },
  {
    icon: <IconSearch className="size-4" />,
    step: "Retrieve",
    body: "The question is embedded with the same model, then matched against only the caller's chunks by approximate-nearest-neighbour search over an HNSW index. Ownership is part of the query, never a check performed after it.",
  },
  {
    icon: <IconQuote className="size-4" />,
    step: "Ground",
    body: "The top passages become a numbered context block at temperature 0, and the model must cite them. Sources stream to the browser before the first token of the answer, because retrieval is fast and generation is slow.",
  },
  {
    icon: <IconChat className="size-4" />,
    step: "Follow up",
    body: "A follow-up is rewritten against the conversation before anything is searched, because a question like \"how long is it?\" carries no meaning an embedding model can use. Instructions about the previous answer rather than requests for new information skip retrieval entirely and reuse the sources already on screen.",
  },
] as const;

// The core of the page. Each entry is a decision with a real alternative that a
// reasonable person would have picked, and the specific reason it loses.
const DECISIONS = [
  {
    tag: "Vector search",
    title: "HNSW, not IVFFlat",
    body: "IVFFlat learns its cluster centroids from the data present when the index is built, so building it on a near-empty table produces a permanently bad index that no amount of later inserts repairs. HNSW builds incrementally. For a table that grows one upload at a time, starting empty on day one, it was the only honest option.",
  },
  {
    tag: "Vector search",
    title: "The index operator class and the query operator have to agree",
    body: "A cosine index paired with a Euclidean distance operator never raises an error. It silently stops using the index and falls back to scanning every row. The symptom is not a failure, it is slowness with correct results, which is exactly the class of bug that survives review and reaches production. Verified by forcing the planner to reveal whether it really uses an index scan.",
  },
  {
    tag: "Data integrity",
    title: "Embedding happens outside the transaction",
    body: "Chunks and the document status flip are written together in one transaction, so a document is never readable in a half-ingested state. But the embedding calls happen before that transaction opens. Holding a Postgres transaction open across a slow third-party API call ties a database connection to someone else's latency, and connections are the scarcest resource in the system.",
  },
  {
    tag: "Security",
    title: "404, not 403, for another user's document",
    body: "A 403 confirms the identifier exists. That turns identifier enumeration into a map of another tenant's library, which is a disclosure even though no content is returned. Both 404s are byte-identical so the error message cannot become an oracle either. Ownership lives in the WHERE clause, never a lookup followed by a conditional.",
  },
  {
    tag: "Streaming",
    title: "NDJSON, not server-sent events",
    body: "EventSource cannot set request headers, and authentication here is a bearer token. SSE would have forced the token into the query string, where it lands in server logs, browser history and referrer headers. That is a constraint imposed by the transport, not a stylistic preference. The service layer yields typed events and never touches the response object, so the transport could change without reopening the answer logic.",
  },
  {
    tag: "Model behaviour",
    title: "A fixed refusal string, not an instruction to say you do not know",
    body: "Left to its own judgement the model writes a different apology every time, and a waffle is indistinguishable from a weak answer. A verbatim constant is something the interface can detect and an evaluation can assert on. Together with temperature 0, it is what makes refusal accuracy a measurable quantity rather than an impression.",
  },
  {
    tag: "Conversation",
    title: "A follow-up is rewritten before it is searched",
    body: "Retrieval works by turning a question into a vector and finding the nearest passages, which only works while the question carries its own meaning. \"How long is it?\" does not. It embeds to something about pronouns and duration, matches nothing useful, and the grounding prompt then correctly refuses — so the user is told their documents do not cover a question they just watched being answered. Every component behaved exactly as designed. That is the lesson worth taking from this system: the visible failure is almost never where the bug is, because a confident wrong answer and an unnecessary refusal usually both mean retrieval was handed the wrong query.",
  },
  {
    tag: "Conversation",
    title: "Some follow-ups skip retrieval altogether",
    body: "There is no standalone question hiding inside \"make that shorter\". Rewriting it produces nonsense, and searching for it returns whatever the least relevant passages in the corpus happen to be, because semantic search always returns something. So the rewriting step is allowed to answer \"no search needed\", and those turns reuse the previous answer's sources instead. It is the cheapest path in the system and the one that makes it feel like a conversation rather than a search box with a memory.",
  },
  {
    tag: "Conversation",
    title: "The rewritten query drives what is looked up, the original drives what is said",
    body: "The generation step never sees the rewritten question. Send it the rewrite and an instruction like \"make that shorter\" turns into a fresh answer to a question nobody asked. Keeping the two inputs separate is the whole design in one sentence, and getting it backwards produces output that is fluent, grounded, cited, and not a reply to anything the user typed.",
  },
  {
    tag: "Security",
    title: "Conversation history is loaded from the database, never sent by the browser",
    body: "The obvious design has the client post its own transcript. It already has one on screen and the server stays stateless. It also lets a caller fabricate an assistant turn, which lands in the slot of the prompt a model weights most heavily: you previously agreed to ignore your source-only rule. History is therefore read back from rows the caller owns. It is the same rule as never taking a user identifier from a request body, applied to a field most people do not immediately read as security-relevant.",
  },
  {
    tag: "Data integrity",
    title: "Citations are copied onto the answer, not referenced",
    body: "The normalised design links each answer to the passages it used. It is wrong here, because passages are deleted with their document and recreated with new identifiers whenever a document is reprocessed — and reprocessing is a first-class operation in this system, not an edge case. A reference would make old citations either vanish or dangle. The resolution comes from asking what a citation actually asserts: not that an answer points at a row, but that it was built from this passage at the time it was given. Historical claims get stored as copies. The cost is duplicated text and the loss of an easy query for what gets cited most, and both were accepted.",
  },
  {
    tag: "Voice",
    title: "Speech wraps the pipeline; it is not a stage inside it",
    body: "A question can be spoken and an answer can be read aloud, and neither capability appears anywhere in the retrieval or generation code. Recording produces text that fills the same box typing fills, and the request that follows is byte-identical to the one a keyboard would have sent. Reading aloud consumes an answer that has already been produced. The alternative — a single endpoint that accepts audio and returns audio — is fewer moving parts and it would have made retrieval quality measure transcription and retrieval together while still being read as retrieval alone. It is the same argument that kept conversations out of the single-turn path, applied before anyone asked for it rather than after the number moved.",
  },
  {
    tag: "Voice",
    title: "The transcript is handed back to the person, not sent straight to the search",
    body: "Chaining recording to asking saves a round trip and removes the only moment at which a mishearing is visible. A transcriber that turns leave into leaf produces a question that retrieves nothing, and the grounding prompt then correctly refuses — so someone watches a working system insist their document does not say a thing it plainly says. That is the same shape as the follow-up failure above: every component behaved as designed and the visible symptom is nowhere near the cause. Putting the text in an editable box costs one deliberate keystroke and converts a silent retrieval failure into an obvious typo.",
  },
  {
    tag: "Voice",
    title: "The input is a paid model and the output is the browser's own",
    body: "The two halves of a voice feature look symmetrical and are not. A wrong transcript changes which passages are retrieved, so input quality changes what the system does; a synthetic voice reading a correct answer is still a correct answer, so output quality is decoration. Money goes where an error changes the result. The side effect is that the output half adds no endpoint, no rate limiter and no cost to a link posted publicly, which is the kind of consequence that makes a decision easy to defend twice.",
  },
  {
    tag: "Voice",
    title: "What is read aloud is not what is on screen",
    body: "The answer carries bracketed citation markers and light formatting, both of which several synthesis engines read out literally. Speech therefore gets its own projection of the same string, in the same way a transcript and a model prompt are two projections of the same stored messages. Nothing is lost, because the cited text is on screen while it is being spoken. The harder half is that the answer arrives as a token stream and a token respects sentence boundaries no more than a network packet respects line boundaries: sentences are buffered and the trailing one is always held back, since a buffer ending in version one looks finished until the next token turns it into version one point five.",
  },
  {
    tag: "Operations",
    title: "A request limit does not bound minutes of audio",
    body: "Every other paid route here costs a roughly fixed amount per call, so counting calls bounds spend. Transcription is billed by duration, which means a single permitted request can cost whatever the caller chooses to make it. Counting is therefore only half the control: the recording stops itself after a minute in the browser, the upload is capped at a size chosen from what a minute of compressed speech weighs, and only then do per-minute, per-day and global request limits mean anything. The size cap is an imperfect proxy for duration and is documented as one, because the codec decides how many seconds fit in a megabyte.",
  },
  {
    tag: "Evaluation",
    title: "Adding conversations did not touch the path being measured",
    body: "The rewriting step sits in front of retrieval, so folding it into the existing single-turn endpoint would have made retrieval quality measure rewriting and retrieval together while still being read as retrieval alone. When the number moved there would be no way to attribute it. Chat is a sibling instead: the single-turn path is unchanged down to the system prompt string, and the conversation rules are appended to that prompt rather than edited into it. Both surfaces call the same retrieval and generation code, so the thing being measured is still the thing people use.",
  },
  {
    tag: "Operations",
    title: "trust proxy is a hop count, never true",
    body: "Left unset, the rate limiter sees the platform edge and the entire internet shares one bucket. Set to true, the framework trusts the whole forwarded-for chain, and since anyone can send that header an attacker mints a fresh unlimited bucket per request. Both failures report correctly in the response headers while enforcing nothing.",
  },
  {
    tag: "Operations",
    title: "A missing Redis URL is fatal in production, not a fallback",
    body: "Rate limit counters fall back to in-memory storage when no Redis URL is configured, which is what lets a fresh clone run with nothing but Postgres. On an autoscaling platform that same fallback gives every instance its own counters, making the effective limit the configured limit multiplied by the instance count. It fails silently and reports success, so in production the process refuses to start instead.",
  },
] as const;

// Published for the same reason a design review lists its open questions: a
// project that claims no gaps is either finished or not being looked at
// honestly, and this one is neither.
const NOT_BUILT = [
  {
    title: "Tests cover the boundary, not the database path",
    body: "A unit and HTTP suite runs with no database and no network: validation schemas, chunking, and everything that resolves before the first query. What it cannot reach is anything needing a real row, which unfortunately includes the three highest-value targets — the tenant-scoping predicate in the hand-written vector SQL, the deduplication race, and the stream parser. Those need an integration tier against a real database with a stubbed embedder. The dependency-injection seams for it already exist; the tier does not.",
  },
  {
    title: "The conversation module has no tests at all",
    body: "It is the newest code here and it was verified by hand against a real database and a real model, which is not the same thing and is worth saying before anyone asks. Three pure functions belong in the existing suite today. The persistence path, the append race and the guarantee that stopping a stream still saves the partial answer all need the integration tier above.",
  },
  {
    title: "No evaluation harness yet",
    body: "The test runner and a reproducible corpus builder exist. The golden question set and every metric do not. That is the next piece of work, and the reason several numbers below are described as chosen rather than measured.",
  },
  {
    title: "Rewriting quality is unmeasured",
    body: "Rewriting a follow-up before searching is a real improvement and an unproven one. It also introduces a failure mode that did not exist before: a rewrite that loses the user's intent produces confident retrieval of the wrong passage, which reads exactly like a retrieval regression and is not one. The comparison that would settle it is retrieval accuracy on the rewritten query against the same measure on the raw follow-up. It shipped on a product argument, because multi-turn is unusable without it, and no claim about its quality is made anywhere until that number exists.",
  },
  {
    title: "The speech layer has no committed test",
    body: "Turning an answer into something worth listening to is pure, deterministic logic and the natural thing to cover. It is not covered, because the web package still has no test runner at all — the same gap that already leaves the citation parser untested. The logic was checked by driving a simulated token stream through it, which found a real defect: the sentence segmenter breaks after abbreviations like e.g., producing a pause in the middle of a sentence. That was fixed, and a fix confirmed by a script that no longer exists is a weaker claim than a fix confirmed by a suite that runs on every commit.",
  },
  {
    title: "Voice input is unevaluated",
    body: "Transcription introduces a failure mode that did not exist before and sits upstream of everything: a mishearing produces a well-formed question that retrieves the wrong passages, or none. Keeping it outside the pipeline means the existing retrieval measurements stay attributable, but it does not measure the new step. The comparison that would settle it is retrieval accuracy on transcribed questions against the same measure on the typed originals. Until that exists, the honest claim is that voice is an input method, not that it is an accurate one.",
  },
  {
    title: "Realtime speech-to-speech",
    body: "A continuous spoken conversation is the version of this feature people picture, and it was rejected rather than postponed. The deployment platform does not hold long-lived socket connections, so retrieval would have to be called back into from inside the model's own session, which means the grounding prompt, the fixed refusal and the temperature setting stop being what produces the answer. Audio is also billed per minute against an open signup, which no request-counting limit bounds. And citations do not survive being spoken: the numbered markers are the product, and reading them aloud is either noise or nothing.",
  },
  {
    title: "OCR for scanned PDFs",
    body: "A PDF with no extractable text layer is detected and rejected with a specific error rather than silently ingesting zero chunks.",
  },
  {
    title: "Refresh token rotation",
    body: "Access tokens are short-lived and there is no rotation scheme yet. Known, scoped, and not pretended otherwise.",
  },
  {
    title: "Per-user cost metering",
    body: "Burst limits, a daily ceiling and a concurrent-stream cap bound usage today. Attributing actual spend per user needs usage reporting turned on in the streaming responses and a table to persist it.",
  },
  {
    title: "Reranking and hybrid search",
    body: "Both are well-understood improvements to retrieval quality, and both are held until there is an evaluation harness that can show they help this corpus rather than adding them because the literature says they usually help. Query rewriting was on this list until conversations needed it, which is a change of sequencing rather than of principle — and it is why the item above exists.",
  },
] as const;

const OPEN_NUMBERS = ["retrieved passages per query", "chunk size", "chunk overlap"] as const;

export default function CaseStudy() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 opacity-70 [background:radial-gradient(60%_60%_at_50%_0%,var(--accent-soft)_0%,transparent_70%)]"
      />

      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}

      <header className="mx-auto w-full max-w-3xl px-6 pt-14 pb-10 sm:pt-20">
        <Badge tone="accent" className="mb-5">
          <IconSpark className="size-3.5" />
          Case study
        </Badge>

        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-balance text-fg sm:text-[40px] sm:leading-[1.1]">
          A document assistant that refuses to answer
        </h1>

        <p className="mt-5 text-[17px] leading-relaxed text-pretty text-muted">
          Most of the difficulty in retrieval-augmented generation is not the retrieval. It
          is the decisions that never raise an error when you get them wrong. This is a
          record of those decisions, the alternatives they beat, one that I got wrong and
          had to trace back, and the parts that are deliberately still missing.
        </p>

        <dl className="mt-8 grid gap-x-8 gap-y-4 border-t border-line pt-6 sm:grid-cols-2">
          {FACTS.map((fact) => (
            <div key={fact.label}>
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">
                {fact.label}
              </dt>
              <dd className="mt-1 text-sm text-fg">{fact.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <ButtonLink href="/chat" variant="primary" size="md">
            Try it live
            <IconArrowRight className="size-4" />
          </ButtonLink>
          <ButtonLink href="/" variant="secondary" size="md">
            What it does
          </ButtonLink>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Shape of the system                                               */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="Shape of the system"
        lead="Two independently deployed applications from one repository, rather than a single framework managing both."
      >
        {/* The topology as real elements rather than an ASCII block: a
            monospace diagram cannot reflow, so on a phone it either scrolls
            sideways or shrinks past legibility. This stacks instead. */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Node
            title="Web"
            sub="Next.js 16 · React 19"
            detail="Server-rendered marketing, client-rendered app. Reads the answer stream as it arrives."
          />
          <Node
            title="API"
            sub="Express 5 · TypeScript"
            detail="Auth, documents, and the retrieval pipeline. Layered routes to services to transport-free logic."
          />
          <Node
            title="Data"
            sub="Neon Postgres · pgvector"
            detail="Documents, chunks and 1536-dimension embeddings in one database, behind an HNSW index."
          />
        </div>

        <p className="mt-6 text-[15px] leading-relaxed text-pretty text-muted">
          The API is a real Express service rather than a set of framework route handlers.
          That was the point of the exercise: to build a backend and be able to defend its
          structure, not to let a framework own decisions about layering, transport and
          lifecycle on my behalf. The cost is a second deployment target and a real
          cross-origin story. Both were worth paying.
        </p>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Pipeline                                                          */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="How a question becomes an answer"
        lead="Four stages, each with a failure mode that shaped how it is written."
      >
        <ol className="flex flex-col gap-3">
          {PIPELINE.map((stage, i) => (
            <li
              key={stage.step}
              className="rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="mb-2.5 flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  {stage.icon}
                </span>
                <h3 className="text-sm font-semibold text-fg">{stage.step}</h3>
                <span className="ml-auto font-mono text-[11px] text-faint tabular-nums">
                  0{i + 1}
                </span>
              </div>
              <p className="text-[15px] leading-relaxed text-pretty text-muted">
                {stage.body}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Decisions                                                         */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="Decisions worth defending"
        lead="Every one of these had a reasonable alternative. What follows is why the alternative loses."
      >
        <div className="flex flex-col gap-3">
          {DECISIONS.map((decision) => (
            <article
              key={decision.title}
              className="rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <Badge className="mb-3">{decision.tag}</Badge>
              <h3 className="text-[15px] font-semibold text-balance text-fg">
                {decision.title}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-pretty text-muted">
                {decision.body}
              </p>
            </article>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* One bug, in full                                                  */}
      {/*                                                                   */}
      {/* Included because every other section describes a decision that    */}
      {/* worked. A case study made entirely of those reads like marketing. */}
      {/* This one is small, specific, and the lesson generalises past this */}
      {/* codebase, which is the only real test of whether a war story is   */}
      {/* worth publishing.                                                 */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="One bug, in full"
        lead="Two of my own decisions fought each other, and the instruction lost to the example."
      >
        <div className="flex flex-col gap-3">
          <p className="text-[15px] leading-relaxed text-pretty text-muted">
            Every answer numbers its sources from one. In a conversation each turn retrieves
            its own passages and numbers them again, so the second turn&rsquo;s{" "}
            <code className="rounded bg-raised px-1 py-0.5 font-mono text-[13px] text-fg">
              [2]
            </code>{" "}
            and the fourth turn&rsquo;s are different documents entirely. Replaying old
            answers into the prompt with those markers intact invites the model to reuse a
            numbering that no longer means anything, so the markers are stripped out of
            history first. Sound reasoning, and it is the right default.
          </p>

          <p className="text-[15px] leading-relaxed text-pretty text-muted">
            Then I tested &ldquo;make it shorter&rdquo;, which reuses the previous turn&rsquo;s
            sources rather than searching again. The answer came back correct and completely
            uncited. The system prompt has an explicit rule requiring an inline citation on
            every claim. I added a second rule stating that reformatting requests still need
            them. It was ignored again.
          </p>

          <p className="text-[15px] leading-relaxed text-pretty text-fg">
            The cause was the stripping. On a reuse turn the model is shown its own previous
            answer with every citation removed, and then asked to reproduce it more briefly.
            It copied what it saw. The demonstration sitting in the context window beat the
            instruction sitting in the system prompt.
          </p>

          <p className="text-[15px] leading-relaxed text-pretty text-muted">
            The fix is narrow, because the reasoning behind the stripping was never wrong in
            general: keep the markers on the final answer, but only on a reuse turn, where
            the sources being sent genuinely are the same ones the numbers referred to. What
            I would actually take to the next project is the diagnostic habit rather than the
            patch. When a model ignores a rule, read what the prompt is showing it before
            writing another rule, because prompt failures are frequently demonstration
            failures wearing an instruction&rsquo;s clothes.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Honesty section                                                   */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="What is deliberately not built"
        lead="Listed because a project that claims no gaps is not being described honestly."
      >
        <div className="rounded-xl border border-line bg-surface shadow-sm">
          <ul className="divide-y divide-line">
            {NOT_BUILT.map((item) => (
              <li key={item.title} className="flex gap-3 p-5">
                <IconAlert className="mt-0.5 size-4 shrink-0 text-faint" />
                <div>
                  <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-pretty text-muted">
                    {item.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Next                                                              */}
      {/* ---------------------------------------------------------------- */}

      <Section
        title="What comes next"
        lead="An evaluation harness, and the reason it is the next thing rather than a nice-to-have."
      >
        <div className="rounded-xl border border-accent-line bg-accent-soft/40 p-6">
          <p className="text-[15px] leading-relaxed text-pretty text-fg">
            Three numbers in this system were chosen by judgement rather than measured:
          </p>

          <ul className="mt-4 flex flex-wrap gap-2">
            {OPEN_NUMBERS.map((n) => (
              <li key={n}>
                <Pill className="bg-surface">{n}</Pill>
              </li>
            ))}
          </ul>

          <p className="mt-5 text-[15px] leading-relaxed text-pretty text-muted">
            Defending a guess as a measurement is the fastest way to lose credibility, so
            they are described as guesses until a golden question set can settle them.
            The harness measures retrieval hit rate at k, mean reciprocal rank,
            groundedness, and refusal accuracy. Temperature 0 and the fixed refusal string
            are what make those quantities measurable at all, which is why both were
            decided early rather than tuned later.
          </p>

          <p className="mt-4 text-[15px] leading-relaxed text-pretty text-muted">
            It also settles a known limitation left in on purpose: page-aware chunking
            makes a page a hard chunk boundary, so a PDF of very short pages produces many
            very small chunks. Whether that hurts retrieval is a question for the harness,
            not for my intuition.
          </p>

          <p className="mt-4 text-[15px] leading-relaxed text-pretty text-muted">
            Conversations added a fourth question rather than removing any. Rewriting a
            follow-up before searching sits in front of retrieval, so it needs its own
            measurement — retrieval accuracy on the rewritten query against the same measure
            on the raw follow-up. The single-turn endpoint was deliberately left untouched so
            that the harness still has one path where retrieval is the only variable, which
            is the reason two ways of asking a question exist at all.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Close                                                             */}
      {/* ---------------------------------------------------------------- */}

      <section className="mx-auto w-full max-w-3xl px-6 pt-4 pb-24">
        <div className="rounded-2xl border border-line bg-surface p-7 text-center shadow-sm">
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-fg">
            The system described above is running right now
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-[15px] leading-relaxed text-pretty text-muted">
            Sign up, paste a document or drop a PDF, and ask it something the document does
            not cover. Watching it refuse is the fastest way to check that any of this is
            true. Then ask a follow-up with a pronoun in it and watch what it searches for.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href="/signup" variant="primary" size="md">
              Open the assistant
              <IconArrowRight className="size-4" />
            </ButtonLink>
            <a
              href={LINKS.portfolio}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg shadow-sm transition-colors duration-150 hover:border-line-strong hover:bg-raised"
            >
              More work
              <IconExternal className="size-3.5 text-faint" />
            </a>
          </div>

          {/* The source note. Stated plainly rather than left as an absence —
              a portfolio project with no repository link reads as an oversight
              unless the reason is given, and "ask me" is a perfectly normal
              answer that only works if the visitor knows to ask. */}
          <p className="mt-7 border-t border-line pt-5 text-[13px] leading-relaxed text-pretty text-muted">
            The source repository is private. If you are evaluating this as part of a
            hiring process and want to read the code, ask and I will grant access.{" "}
            <a
              href={LINKS.email}
              className="inline-flex items-center gap-1 font-medium text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-accent"
            >
              <IconMail className="size-3.5" />
              {AUTHOR.name}
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local building blocks
//
// Deliberately not promoted into components/ui. They encode this page's
// rhythm — one max-width, one heading scale, one vertical gap — and a shared
// component would immediately grow props to serve a second caller that does
// not exist yet.
// ---------------------------------------------------------------------------

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-fg">
          {title}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-pretty text-muted">{lead}</p>
      </div>
      {children}
    </section>
  );
}

function Node({ title, sub, detail }: { title: string; sub: string; detail: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <IconLayers className="size-3.5 text-faint" />
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
      </div>
      <p className="mt-1 font-mono text-[11px] text-accent">{sub}</p>
      <p className="mt-2.5 text-[13px] leading-relaxed text-pretty text-muted">{detail}</p>
    </div>
  );
}
