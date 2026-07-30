import type { Metadata } from "next";
import { AUTHOR, LINKS } from "@/lib/site";
import { Badge, Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import {
  IconAlert,
  IconArrowRight,
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
    "How the RAG Knowledge Assistant is built: architecture, the decisions worth defending, and what was deliberately left out.",
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
  { label: "Model", value: "text-embedding-3-small · gpt-4o-mini" },
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
    title: "No automated test suite",
    body: "Verification so far is runtime scripts and end-to-end probes against the deployed system. The application factory is already structured to be driven by a test harness, which is the part that would otherwise be expensive to retrofit.",
  },
  {
    title: "No evaluation harness yet",
    body: "This is the next piece of work and the reason several numbers below are described as chosen rather than measured.",
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
    title: "Reranking, hybrid search, query rewriting",
    body: "All three are well-understood improvements to retrieval quality. All three are held until there is an evaluation harness that can show they help this corpus, rather than adding them because the literature says they usually help.",
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
          record of those decisions, the alternatives they beat, and the parts that are
          deliberately still missing.
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
          <ButtonLink href="/ask" variant="primary" size="md">
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
        lead="Three stages, each with a failure mode that shaped how it is written."
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
            true.
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
