"use client";

import { useState } from "react";
import type { Source } from "@/lib/api";

// The citations panel: what the answer was actually built from.
//
// This is the part that separates a RAG app from a chatbot with extra steps. An
// ungrounded answer and a grounded one look identical on screen — confident
// prose either way — so the only thing that makes "grounded" a claim a user can
// check is showing them the retrieved text and letting them read it.
//
// Sources render as soon as the `sources` event lands, BEFORE the first token,
// which is why the server emits that event first: retrieval finishes fast,
// generation is the slow part, and filling the screen during the wait is free.

type SourceListProps = {
  sources: Source[];
  // Set when a citation chip was clicked, so the matching card can highlight
  // itself. Controlled from the page rather than held here, because the trigger
  // lives in a sibling component.
  focused: number | null;
};

export function SourceList({ sources, focused }: SourceListProps) {
  if (sources.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {sources.map((source) => (
        <SourceCard
          key={`${source.documentId}-${source.chunkIndex}`}
          source={source}
          focused={focused === source.n}
        />
      ))}
    </ul>
  );
}

function SourceCard({ source, focused }: { source: Source; focused: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Collapsed by default: a chunk is up to ~1000 characters, and five of them
  // expanded would bury the answer they exist to support. The preview is enough
  // to recognise the passage; the toggle is there for verifying it.
  const preview = source.content.slice(0, 180);
  const truncated = source.content.length > preview.length;

  return (
    <li
      // `id` is what the citation chip scrolls to — see the page's
      // onCitationClick. Derived from `n` so the two sides agree by construction.
      id={`source-${source.n}`}
      className={`rounded-md border p-3 transition-colors ${
        focused
          ? "border-black/40 bg-black/[0.03] dark:border-white/40 dark:bg-white/[0.04]"
          : "border-black/10 dark:border-white/10"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-black/8 text-[10px] font-semibold tabular-nums dark:bg-white/10">
            {source.n}
          </span>
          <span className="truncate text-xs font-medium">{source.documentTitle}</span>
        </div>

        <span
          className="shrink-0 text-[10px] text-black/40 tabular-nums dark:text-white/40"
          // The raw cosine similarity, surfaced deliberately. It's the fastest
          // way to see WHY an answer was weak: a top hit at 0.31 means retrieval
          // found nothing relevant, which is a very different bug from the model
          // misreading a good chunk. Most products hide this; during development
          // it's the single most useful number on the page.
          title={`Cosine similarity — chunk ${source.chunkIndex}`}
        >
          {source.similarity.toFixed(3)}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed break-words text-black/60 dark:text-white/60">
        {expanded ? source.content : preview}
        {truncated && !expanded && "…"}
      </p>

      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[11px] underline underline-offset-4 opacity-60 hover:opacity-100"
        >
          {expanded ? "Show less" : "Show full chunk"}
        </button>
      )}
    </li>
  );
}
