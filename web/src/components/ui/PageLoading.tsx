import { Spinner } from "./Spinner";

// The gap between "we have a token in localStorage" and "the api confirmed it".
// Every protected page hit this state and rendered its own centred "Loading…"
// paragraph; three copies, three slightly different colours.
//
// A spinner rather than a skeleton, on purpose: a skeleton promises a specific
// layout is about to appear, and this state can just as easily resolve to a
// redirect to /login. Promising content that never arrives is worse than not
// promising anything.
export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center gap-2.5 py-24 text-muted"
      // Announced politely so a screen reader says "Loading" once, instead of
      // silently sitting on an empty page.
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-4" />
      <span className="text-sm">{label}…</span>
    </div>
  );
}
