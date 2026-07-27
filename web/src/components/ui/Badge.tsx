import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Tones name a MEANING, not a colour — `danger`, not `red`. Same reasoning as
// the button variants: the mapping from meaning to colour belongs in one place,
// so a themed rebuild changes this file and nothing else.
type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-raised text-muted border-line",
  accent: "bg-accent-soft text-accent border-accent-line",
  success: "bg-success-soft text-success border-success/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  danger: "bg-danger-soft text-danger border-danger/25",
};

export function Badge({
  tone = "neutral",
  dot = false,
  pulse = false,
  className,
  children,
}: {
  tone?: Tone;
  /** A leading status dot. Carries no information on its own — see below. */
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
    >
      {/* The dot is decoration that reinforces the label, never a replacement
          for it. Colour-only status is unreadable to ~8% of men, and invisible
          to a screen reader regardless — so the text always ships too. */}
      {dot && (
        <span
          className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

// A small monospace pill for numbers that need to line up: citation indices,
// similarity scores, counts. `tabular-nums` is the whole point — proportional
// digits make a column of scores look ragged even when it's perfectly aligned.
export function Pill({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted tabular-nums",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
