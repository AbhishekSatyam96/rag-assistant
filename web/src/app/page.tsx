import { HeroActions } from "@/components/HeroActions";
import { Badge, Pill } from "@/components/ui/Badge";
import { IconFile, IconLayers, IconQuote, IconSearch, IconSpark } from "@/components/icons";

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
          Upload what you know. Ask in plain language. Every sentence comes back with a
          citation you can open and read — grounded in your documents, or not answered
          at all.
        </p>

        <HeroActions />
      </section>

      {/* The product, shown rather than described. A static mock, not a live
          demo: it costs nothing, can't fail, and communicates the citation
          model faster than the paragraph above it. */}
      <section className="mx-auto w-full max-w-2xl px-6 pb-16">
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2.5">
            <IconSearch className="size-3.5 text-faint" />
            <span className="text-[13px] text-muted">
              {"What's our policy on remote work?"}
            </span>
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
              <MockSource n={1} title="handbook-2026.pdf" page={12} score="0.847" />
              <MockSource n={2} title="remote-work-policy.pdf" page={3} score="0.812" />
            </div>
          </div>
        </div>
      </section>

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
      </section>
    </div>
  );
}

function MockCite({ n }: { n: number }) {
  return (
    <span className="mx-0.5 inline-flex size-[18px] translate-y-px items-center justify-center rounded-[5px] bg-accent-soft align-baseline text-[10px] font-semibold text-accent tabular-nums">
      {n}
    </span>
  );
}

function MockSource({
  n,
  title,
  page,
  score,
}: {
  n: number;
  title: string;
  page: number;
  score: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-accent-soft text-[10px] font-semibold text-accent tabular-nums">
        {n}
      </span>
      <span className="truncate text-xs font-medium text-fg">{title}</span>
      <span className="shrink-0 text-[11px] text-faint tabular-nums">p. {page}</span>
      <Pill className="ml-auto shrink-0">{score}</Pill>
    </div>
  );
}
