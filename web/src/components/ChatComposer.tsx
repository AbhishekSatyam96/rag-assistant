"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { IconArrowRight, IconSearch, IconStop } from "@/components/icons";
import { cn } from "@/lib/cn";

// The question input, shared by /ask and /chat.
//
// Extracted rather than copied when chat arrived. Everything in here is a small
// correctness detail that took a specific bug to discover — the IME guard, the
// auto-grow reset, the `mt-3` that keeps the icon against the first line — and a
// second copy means the next fix lands in one of them. This is the same argument
// that moved the NDJSON reader into lib/ndjson.ts.

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  // Takes the text as an ARGUMENT rather than letting the parent read its own
  // state. That is what lets a suggestion chip submit in one click: setting
  // state and immediately calling submit would send the previous value, because
  // the update has not reached that closure yet.
  onSubmit: (value: string) => void;
  onStop: () => void;
  streaming: boolean;
  placeholder?: string;
  // Focus on mount. Guarded internally on `(pointer: fine)` — see below.
  autoFocus?: boolean;
  className?: string;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  placeholder = "What do your documents say about…?",
  autoFocus = false,
  className,
}: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea to fit its content.
  //
  // Keyed on `value` rather than done in onChange, because the value also
  // changes programmatically — clicking a suggestion calls onChange from
  // outside, and an onChange-only implementation would leave the box one line
  // tall with the text scrolled out of sight. An effect covers both paths by
  // construction.
  //
  // `height = "auto"` first is load-bearing: scrollHeight can only report a
  // value at least as large as the current height, so measuring without the
  // reset means the box can grow but never shrink again after a deletion. The
  // 5-line ceiling is CSS (`max-h-34`), not JS — the browser clamps the
  // assignment and hands over a scrollbar, so there is no maximum to keep in
  // sync across two files.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Guarded on `(pointer: fine)` rather than a width breakpoint: what makes
  // autofocus hostile is a virtual keyboard sliding up and eating half the
  // screen before you have read the page, which tracks the input DEVICE, not the
  // viewport. A 1024px-wide tablet is the case a `sm:` check gets wrong.
  useEffect(() => {
    if (!autoFocus) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className={className}
    >
      {/* The input and its button share one bordered container rather than
          sitting side by side with a gap. `focus-within` moves the focus ring to
          that container, so the whole control lights up as a single object —
          which is what it is.

          `items-end`, so that as the textarea grows the button stays pinned to
          the bottom edge next to the last line rather than drifting to the
          vertical middle of a five-line box. */}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
        {/* `mt-3` centres the icon against the FIRST line (the 40px row minus the
            16px icon, halved) instead of letting `items-end` drop it to the
            bottom of a grown box, where it would label nothing. */}
        <IconSearch className="mt-3 ml-2 size-4 shrink-0 self-start text-faint" />
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits, Shift+Enter breaks the line — the convention every
            // chat input has trained users into. Without this a textarea
            // silently downgrades the primary action from "press Enter" to "go
            // find the button".
            if (e.key !== "Enter" || e.shiftKey) return;

            // An IME (Japanese, Chinese, Korean) uses Enter to COMMIT the
            // candidate you are picking, and fires keydown for it while
            // composition is still open. Submitting there would send a
            // half-converted question and clear the box mid-word — a bug
            // invisible to anyone testing in English.
            if (e.nativeEvent.isComposing) return;

            e.preventDefault();
            onSubmit(value);
          }}
          placeholder={placeholder}
          // Mirrors the server's zod ceiling. Client validation here is UX only
          // — it saves a round trip; the server's copy is what is load-bearing.
          maxLength={1000}
          disabled={streaming}
          aria-label="Your question"
          // `py-2` + `leading-6` makes a single line exactly 40px — the same
          // height as the md Button beside it — so the control does not change
          // shape between the empty state and the first character typed.
          //
          // The border/ring lives on the parent, so this strips its own
          // entirely, including the global :focus-visible outline that would
          // otherwise draw a second ring inside the first.
          className={cn(
            "scrollbar-slim min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6",
            "max-h-34 text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none disabled:text-muted",
          )}
        />
        {streaming ? (
          // Swapping Ask for Stop rather than showing both: while a stream is
          // running, stopping it is the only useful action.
          <Button onClick={onStop} variant="secondary" className="shrink-0">
            <IconStop className="size-3.5" />
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            disabled={!value.trim()}
            className="shrink-0"
          >
            Ask
            <IconArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
