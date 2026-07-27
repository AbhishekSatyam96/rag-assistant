import { cn } from "@/lib/cn";

// A ring with a gap, spun. Built from a border rather than an SVG arc so it
// scales with `size-*` and inherits `currentColor` on three sides while the
// fourth stays transparent — that transparent quarter is the only reason the
// rotation is visible at all.
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-[1.05em] animate-spin rounded-full border-2 border-current border-t-transparent align-[-0.15em]",
        className,
      )}
      aria-hidden
    />
  );
}
