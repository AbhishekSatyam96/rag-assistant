import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Surfaces get depth from three stacked cues, in this order of importance:
// a lighter background than the canvas, a hairline border, then a shadow.
// Dark UIs lean on the first (a shadow on near-black is invisible), light UIs
// on the last — the tokens already encode that difference, so this component
// doesn't branch on theme at all.
export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-line bg-surface shadow-sm", className)}
      {...props}
    >
      {children}
    </div>
  );
}

// A section heading with an optional trailing slot. Used above every list in
// the app so the vertical rhythm between "Sources", "Your documents" and
// "Answer" is identical rather than three near-misses.
export function SectionHeading({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] text-muted uppercase">
        {children}
      </h2>
      {aside}
    </div>
  );
}

// The shape every empty list uses. Dashed border because it reads as "a slot
// waiting to be filled" rather than "a card containing a sentence" — a small
// signal, but it's the difference between an empty state that looks intentional
// and one that looks broken.
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      {icon && (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-raised text-lg text-muted">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <p className="max-w-xs text-[13px] text-muted">{children}</p>}
    </div>
  );
}
