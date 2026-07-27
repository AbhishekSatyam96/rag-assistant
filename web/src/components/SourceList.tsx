"use client";

import { useState } from "react";
import type { Source } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Pill } from "@/components/ui/Badge";
import { IconExpand, IconFile } from "@/components/icons";

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
      {sources.map((source, i) => (
        <li
          key={`${source.documentId}-${source.chunkIndex}`}
          className="animate-rise"
          // Sources all arrive in one event, so without this they'd appear as a
          // single block. A 40ms cascade reads as "these came back from a
          // search" rather than "the layout jumped".
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <SourceCard source={source} focused={focused === source.n} />
        </li>
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
    <div
      // `id` is what the citation chip scrolls to — see the page's
      // onCitationClick. Derived from `n` so the two sides agree by construction.
      id={`source-${source.n}`}
      // `scroll-mt` keeps the card clear of the sticky header when it's scrolled
      // into view. Without it, clicking a citation lands the card's top edge
      // underneath the header — the one thing you were trying to read.
      className={cn(
        "scroll-mt-20 rounded-xl border bg-surface p-3.5 shadow-sm transition-[border-color,box-shadow,background-color] duration-200",
        focused
          ? "border-accent ring-4 ring-accent/15"
          : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums transition-colors",
              focused ? "bg-accent text-on-accent" : "bg-accent-soft text-accent",
            )}
          >
            {source.n}
          </span>
          <IconFile className="size-3.5 shrink-0 text-faint" />
          <span className="truncate text-xs font-medium text-fg">
            {source.documentTitle}
          </span>
          {/* The point of PDF ingestion, in one line of UI. `page` is set only
              when the document had pages, so a pasted-text source simply shows
              nothing here — deliberately no "chunk 12" fallback, because that
              names an internal detail the reader cannot go and verify, which is
              the opposite of what a citation is for. */}
          {source.page !== null && (
            <span className="shrink-0 text-[11px] whitespace-nowrap text-faint tabular-nums">
              p. {source.page}
            </span>
          )}
        </div>

        <Pill
          // The raw cosine similarity, surfaced deliberately. It's the fastest
          // way to see WHY an answer was weak: a top hit at 0.31 means retrieval
          // found nothing relevant, which is a very different bug from the model
          // misreading a good chunk. Most products hide this; during development
          // it's the single most useful number on the page.
          title={`Cosine similarity — chunk ${source.chunkIndex}`}
          className="shrink-0"
        >
          {source.similarity.toFixed(3)}
        </Pill>
      </div>

      <p className="mt-2.5 text-xs leading-relaxed wrap-break-word text-muted">
        {expanded ? source.content : preview}
        {truncated && !expanded && "…"}
      </p>

      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 inline-flex items-center gap-1.5 rounded text-[11px] font-medium text-muted transition-colors hover:text-fg"
        >
          <IconExpand className="size-3" />
          {expanded ? "Show less" : "Show full chunk"}
        </button>
      )}
    </div>
  );
}
