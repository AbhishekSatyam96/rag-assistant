// Joins class names, dropping anything falsy so conditional classes can be
// written inline:  cn("base", isActive && "bg-accent", className)
//
// Deliberately NOT clsx + tailwind-merge. That pair is the reflex install, and
// it's ~8 kB to solve a problem this codebase doesn't have: tailwind-merge
// exists to resolve *conflicting* utilities (`p-2` losing to a later `p-4`),
// which only becomes necessary when callers routinely override a component's
// own padding. Here the primitives expose variants for the things that vary,
// and `className` is used for layout (margins, width, grid placement) — which
// never collides. If that stops being true, this file is the one place to swap.
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
