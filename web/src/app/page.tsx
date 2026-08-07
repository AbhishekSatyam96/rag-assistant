import { HeroActions } from "@/components/HeroActions";
import { AUTHOR, LINKS } from "@/lib/site";
import { Badge, Pill } from "@/components/ui/Badge";
import {
  IconExternal,
  IconFile,
  IconGitHub,
  IconLayers,
  IconQuote,
  IconSearch,
  IconSpark,
} from "@/components/icons";

// A Server Component, deliberately. Everything here is static marketing copy,
// so it ships as HTML with no JS — the one interactive bit (the CTA row, which
// has to know whether you're signed in) is islanded into HeroActions. Making
// the whole page "use client" to read one boolean would push the entire hero,
// the mock and the pipeline into the bundle for no benefit.

const STEPS = [
  {
    icon: <IconFile className="size-4" />,
    title: "Ingest",
    body: "Paste text or upload a PDF. It is split into overlapping chunks and embedded with text-embedding-3-small.",
  },
  {
    icon: <IconSearch className="size-4" />,
    title: "Retrieve",
    body: "Your question is embedded too, then matched against your chunks by cosine similarity over an HNSW index in pgvector.",
  },
  {
    icon: <IconQuote className="size-4" />,
    title: "Ground",
    body: "Only the top-k passages reach the model, and it must cite them. No supporting passage, no answer.",
  },
];

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Decorative accent wash behind the hero. `pointer-events-none` because
          a full-bleed absolutely-positioned div will happily eat clicks on
          everything underneath it — the classic way a pretty background breaks
          a button. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] opacity-70 [background:radial-gradient(60%_60%_at_50%_0%,var(--accent-soft)_0%,transparent_70%)]"
      />

      <section className="mx-auto w-full max-w-3xl px-6 pt-16 pb-14 text-center sm:pt-24">
        <Badge tone="accent" className="mb-5">
          <IconSpark className="size-3.5" />
          Retrieval-augmented generation
        </Badge>

        {/* text-balance keeps the headline from breaking with one orphan word
            on the last line — the cheapest typographic win available. */}
        <h1 className="text-4xl font-semibold tracking-[-0.03em] text-balance text-fg sm:text-5xl">
          Ask your documents.
          <br />
          <span className="text-accent">Verify every answer.</span>
        </h1>

        <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-pretty text-muted">
          Upload what you know. Ask in plain language, typed or out loud. Every sentence
          comes back with a citation you can open and read — grounded in your documents,
          or not answered at all.
        </p>

        <HeroActions />

        {/* Under the CTAs on purpose. This is a portfolio piece, and most
            visitors arrive from a LinkedIn post — but the attribution still
            sits *below* the thing they came to try, not above it. The footer
            carries the full version for anyone who scrolls. */}
        {/* <p className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-muted">
          A portfolio project by
          <a
            href={LINKS.portfolio}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-accent"
          >
            {AUTHOR.name}
            <IconExternal className="size-3 text-faint" />
          </a>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-fg"
          >
            <IconGitHub className="size-3.5" />
            Source on GitHub
          </a>
        </p> */}
      </section>

      {/* The product, shown rather than described. A static mock, not a live
          demo: it costs nothing, can't fail, and communicates the citation
          model faster than the paragraph above it.

          A <figure> with a real caption, because the previous version was
          indistinguishable from a working control. Its top bar was a magnifier
          plus muted text — the universal signal for "empty input" — so visitors
          clicked it, typed, and got nothing. The failure mode of an unlabelled
          mock isn't "looks fake", it's "looks broken". The caption names it as
          an example, and the question below reads as one already ASKED rather
          than one waiting to be typed. */}
      <figure className="mx-auto w-full max-w-2xl px-6 pb-16">
        {/* aria-hidden on the fabricated body only, never on the caption. This
            is invented HR policy with invented similarity scores; narrating it
            to a screen reader as though it were information is worse than
            saying nothing, so the caption outside carries the meaning instead.
            `select-none` + `pointer-events-none` finish the job for everyone
            else — nothing here highlights, hovers or takes a click. */}
        <div
          aria-hidden
          className="pointer-events-none overflow-hidden rounded-2xl border border-line bg-surface shadow-lg select-none"
        >
          <div className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2.5">
            <span className="text-sm font-medium text-fg">
              {"What's our policy on remote work?"}
            </span>
            <Badge className="ml-auto">Example</Badge>
          </div>

          <div className="px-5 py-4">
            <p className="text-sm leading-relaxed text-fg">
              Employees may work remotely up to three days per week
              <MockCite n={1} /> with manager approval. Fully remote arrangements need
              a written exception from the department head
              <MockCite n={2} />.
            </p>

            <div className="mt-5 flex items-center gap-2">
              <IconLayers className="size-3.5 text-faint" />
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                Sources
              </span>
            </div>

            <div className="mt-2.5 flex flex-col gap-2">
              <MockSource
                n={1}
                title="handbook-2026.pdf"
                page={12}
                score="0.847"
                preview="Remote work. Employees in eligible roles may work remotely up to three days per week, subject to written approval from their direct manager…"
              />
              <MockSource
                n={2}
                title="remote-work-policy.pdf"
                page={3}
                score="0.812"
                preview="Exceptions. A fully remote arrangement requires a documented exception approved by the department head and reviewed at each performance cycle…"
              />
            </div>
          </div>
        </div>

        <figcaption className="mt-3 text-center text-[13px] text-muted">
          An example answer and the passages it was built from.
        </figcaption>
      </figure>

      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  {step.icon}
                </span>
                <span className="text-[11px] font-mono text-faint tabular-nums">
                  0{i + 1}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-fg">{step.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{step.body}</p>
            </div>
          ))}
        </div>

        {/* Voice deliberately does NOT get a fourth card. Making it step 04
            would say it is part of the pipeline, and the whole design argument
            is that it is not — the retrieval and generation code cannot tell a
            spoken question from a typed one, which is what keeps the evaluation
            harness measuring retrieval rather than transcription plus
            retrieval. A sentence that says so is more accurate than a card that
            implies otherwise. */}
        <p className="mx-auto mt-6 max-w-2xl text-center text-[13px] leading-relaxed text-pretty text-muted">
          Voice sits either side of those three steps rather than inside them. A spoken
          question becomes text before anything is searched, and a finished answer is read
          back sentence by sentence as it streams — so the pipeline never learns which one
          you used.
        </p>
      </section>
    </div>
  );
}

// MockCite and MockSource are a second, static copy of CitationChip and
// SourceCard. Kept separate on purpose — the real ones are Client Components
// carrying click handlers and expand/collapse state, and importing them here
// would drag this page's whole subtree into the bundle to render text that
// never changes.
//
// The cost is drift, and it had already happened: this chip was `size-[18px]`
// and `mx-0.5` against the real chip's `size-4.5` and `mx-0.75`, and the source
// row had no file icon and no chunk preview at all. Both now mirror their live
// counterparts class for class, so a visitor recognises the real thing when
// they reach it.

function MockCite({ n }: { n: number }) {
  return (
    <span className="mx-0.75 inline-flex size-4.5 translate-y-px items-center justify-center rounded-[5px] bg-accent-soft align-baseline text-[10px] font-semibold text-accent tabular-nums">
      {n}
    </span>
  );
}

function MockSource({
  n,
  title,
  page,
  score,
  preview,
}: {
  n: number;
  title: string;
  page: number;
  score: string;
  /** A slice of the retrieved chunk — the part that makes "grounded" checkable. */
  preview: string;
}) {
  return (
    // `bg-canvas` rather than the real card's `bg-surface`: these sit INSIDE a
    // surface here, and a surface on a surface has no edge. The live page has
    // them on the canvas, where the relationship is the other way round.
    <div className="rounded-xl border border-line bg-canvas p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[10px] font-semibold text-accent tabular-nums">
          {n}
        </span>
        <IconFile className="size-3.5 shrink-0 text-faint" />
        <span className="truncate text-xs font-medium text-fg">{title}</span>
        <span className="shrink-0 text-[11px] whitespace-nowrap text-faint tabular-nums">
          p. {page}
        </span>
        <Pill className="ml-auto shrink-0">{score}</Pill>
      </div>

      {/* The passage itself, which the old mock omitted entirely. Showing the
          answer and hiding its evidence sells the wrong product — the retrieved
          text is the only thing that separates this from a chatbot. Clamped to
          two lines so a narrow screen can't turn the figure into a wall. */}
      <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted">{preview}</p>
    </div>
  );
}
