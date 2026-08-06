"use client";

import type { Source } from "@/lib/api";
import { parseCitations } from "@/lib/citations";
import { cn } from "@/lib/cn";

// Renders a streamed answer, turning the model's inline "[2]" markers into real
// citation chips. Used by both /ask and the chat thread — which is why the
// parsing itself now lives in lib/citations.ts rather than in this file.
//
// `sources` is the list belonging to THIS answer, not "the current sources".
// In a conversation each turn retrieves its own chunks and numbers them from 1
// again, so a turn-3 answer's "[2]" and a turn-1 answer's "[2]" point at
// different passages. Passing each message its own snapshot is what keeps an
// old answer's chips resolving to the evidence it was actually built from.

type AnswerViewProps = {
  answer: string;
  sources: Source[];
  streaming: boolean;
  onCitationClick: (n: number) => void;
};

export function AnswerView({
  answer,
  sources,
  streaming,
  onCitationClick,
}: AnswerViewProps) {
  const segments = parseCitations(answer);

  return (
    // `whitespace-pre-wrap` preserves the model's own line breaks and bullet
    // layout without pulling in a markdown renderer. Worth knowing this is a
    // deliberate stopping point: the answer IS markdown, and rendering it
    // properly means sanitising it, since the text originates from a model
    // reading user-supplied documents.
    //
    // `text-[15px]` rather than the 14px used everywhere else: this is the one
    // block on the page meant to be *read* as prose rather than scanned, and it
    // gets the looser leading to match.
    <div className="text-[15px] leading-[1.7] whitespace-pre-wrap text-fg">
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <span key={i}>{segment.value}</span>
        ) : (
          <CitationChip
            key={i}
            n={segment.n}
            // A model can hallucinate a citation number that doesn't exist —
            // "[7]" when only 5 sources were sent. Checking against the real
            // list means an invented marker renders as inert text instead of a
            // button that scrolls nowhere.
            valid={sources.some((s) => s.n === segment.n)}
            onClick={onCitationClick}
          />
        ),
      )}

      {/* A blinking caret while tokens are still arriving. It renders inline
          after the last character, so "is the model still working?" is answered
          without a separate spinner competing for attention. */}
      {streaming && (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-0.5 translate-y-[0.15em] animate-caret rounded-full bg-accent align-baseline"
          aria-hidden
        />
      )}
    </div>
  );
}

function CitationChip({
  n,
  valid,
  onClick,
}: {
  n: number;
  valid: boolean;
  onClick: (n: number) => void;
}) {
  if (!valid) return <span className="text-faint">[{n}]</span>;

  return (
    <button
      type="button"
      onClick={() => onClick(n)}
      // aria-label because the visible text is just a number — a screen reader
      // would otherwise announce "1" with no indication it's a citation link.
      aria-label={`Jump to source ${n}`}
      className={cn(
        "mx-0.75 inline-flex size-4.5 translate-y-px items-center justify-center rounded-[5px]",
        "bg-accent-soft align-baseline text-[10px] font-semibold text-accent tabular-nums",
        "transition-colors duration-150 hover:bg-accent hover:text-on-accent",
      )}
    >
      {n}
    </button>
  );
}
