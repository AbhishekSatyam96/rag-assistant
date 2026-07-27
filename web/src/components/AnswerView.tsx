"use client";

import type { Source } from "@/lib/api";
import { cn } from "@/lib/cn";

// Renders the streamed answer, turning the model's inline "[2]" markers into
// real citation chips.
//
// The parsing is done at RENDER time on the accumulated text, not once when the
// stream finishes. That matters because the text grows token by token: a marker
// may briefly arrive as "[", then "[1", then "[1]". Re-deriving from the current
// string each render means a half-typed marker simply displays as the literal
// characters it currently is, and becomes a chip the instant it completes. The
// alternative — parsing incrementally and keeping a cursor — has to handle the
// partial-marker state explicitly, for no benefit.

const CITATION = /\[(\d+)\]/g;

type Segment =
  | { kind: "text"; value: string }
  | { kind: "citation"; n: number };

// Split "runs first [2] and then [3]" into alternating text/citation segments.
// Exported so it can be unit-tested without rendering anything — the logic most
// likely to break is the parsing, not the markup.
export function parseCitations(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  // `matchAll` rather than a `while (exec())` loop: exec on a /g regex mutates
  // `lastIndex` on the shared regex object, so a module-level regex used this
  // way carries state between calls and skips matches on every other render.
  // A genuinely nasty bug, and one this component would hit constantly.
  for (const match of text.matchAll(CITATION)) {
    const index = match.index;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({ kind: "citation", n: Number(match[1]) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return segments;
}

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
