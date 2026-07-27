"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, listDocuments, streamAsk, type Source } from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AnswerView } from "@/components/AnswerView";
import { SourceList } from "@/components/SourceList";
import { PageHeader } from "@/components/AppShell";
import { PageLoading } from "@/components/ui/PageLoading";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { SectionHeading } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import {
  IconArrowRight,
  IconFile,
  IconLayers,
  IconSearch,
  IconSpark,
  IconStop,
} from "@/components/icons";

// Starter questions for an empty page. A blank input with no prompt is the
// hardest possible first interaction — these are generic enough to work against
// any corpus, and clicking one submits immediately rather than just filling the
// box, because a second click to confirm is pure friction.
const EXAMPLES = [
  "Summarise the key points across my documents.",
  "What are the main topics covered?",
  "List anything that looks like a rule, limit or deadline.",
];

export default function AskPage() {
  // `logout` moved to the shell's user menu, along with the nav links this
  // page's header used to carry.
  const { user, token, status } = useRequireAuth();

  const [question, setQuestion] = useState("");
  // The question the CURRENT result belongs to. Separate from `question`,
  // which tracks the input and changes as you type — without this, editing the
  // box would silently re-caption an answer that came from something else.
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedSource, setFocusedSource] = useState<number | null>(null);

  // Does this account have anything to search at all?
  //
  // Without this check the first run of a brand-new account is: sign up, ask,
  // and get a correct, honest "the documents don't contain that" — which is
  // indistinguishable from a broken product. The refusal is the feature, so
  // the fix isn't to soften it; it's to never let someone meet it before
  // they've added anything.
  const [library, setLibrary] = useState<"loading" | "empty" | "stocked">("loading");

  useEffect(() => {
    // Starts null on a hard refresh and arrives once the context has
    // re-validated it, same as on /documents.
    if (!token) return;
    let cancelled = false;

    listDocuments(token)
      .then(({ documents }) => {
        if (cancelled) return;
        // READY specifically, not `length`: a document still PROCESSING has no
        // embedded chunks yet, so it cannot be retrieved against.
        setLibrary(documents.some((d) => d.status === "READY") ? "stocked" : "empty");
      })
      .catch(() => {
        // Fail OPEN. If this check itself fails we know nothing about the
        // library, and blocking a user who has fifty documents behind a "you
        // have none" screen — because one list request timed out — is a far
        // worse outcome than showing the normal page. Asking anyway will
        // surface the real error from the real request.
        if (!cancelled) setLibrary("stocked");
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // In a ref, not state: aborting must not trigger a render, and the handler
  // needs to reach the CURRENT controller. A state value would be captured by
  // the closure at the render that created it, so "Stop" could end up aborting
  // a request that already finished.
  const abortRef = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLElement>(null);

  // Abort on unmount. Navigating away mid-answer should stop the server
  // generating (and stop us paying for) tokens nobody will read — the api wires
  // this abort straight through to the OpenAI request. Without it, `setAnswer`
  // would also fire on an unmounted component.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Grow the textarea to fit its content.
  //
  // Keyed on `question` rather than done in onChange, because the value also
  // changes programmatically — clicking an example chip calls setQuestion, and
  // an onChange-only implementation would leave the box one line tall with the
  // text scrolled out of sight. An effect covers both paths by construction.
  //
  // `height = "auto"` first is load-bearing: scrollHeight can only report a
  // value at least as large as the current height, so measuring without the
  // reset means the box can grow but never shrink again after a deletion.
  // The 5-line ceiling is CSS (`max-h-34`), not JS — the browser clamps the
  // assignment and hands over a scrollbar, so there's no maximum to keep in
  // sync across two files.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [question]);

  // Focus the question box on arrival — this page exists to be typed into.
  //
  // Guarded on `(pointer: fine)` rather than a width breakpoint: the thing that
  // makes autofocus hostile is a virtual keyboard sliding up and eating half
  // the screen before you've read the page, which tracks the input device, not
  // the viewport. A 1024px-wide tablet is the case a `sm:` check gets wrong.
  //
  // Depends on `status` because the textarea isn't mounted until auth resolves;
  // on a hard refresh a mount-only effect would run while PageLoading is still
  // on screen and find a null ref.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    inputRef.current?.focus();
  }, [status]);

  // Bring the answer into view when a NEW question is asked.
  //
  // `asked` is the right dependency: it changes once per submission, while
  // `answer` changes on every token — keying this to the answer would fight the
  // user for the scroll position for the entire duration of the stream.
  //
  // Re-asking the identical question doesn't re-scroll, since the string is
  // unchanged. That's the correct outcome anyway: you're already looking at the
  // answer you just re-ran.
  useEffect(() => {
    if (!asked) return;
    answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [asked]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  // Takes the question as an ARGUMENT rather than reading the `question` state.
  // That's what lets an example chip submit in one click: setting state and
  // immediately calling ask() would send the previous value, because the state
  // update hasn't been applied to this closure yet. Passing it explicitly
  // sidesteps the whole class of bug.
  const ask = useCallback(
    async (raw: string) => {
      if (!token || streaming) return;

      const trimmed = raw.trim();
      // Mirrors the server's zod rule. Client validation here is UX only — it
      // saves a round-trip; the server's copy is the one that's load-bearing.
      if (!trimmed) return;

      // Keep the box in sync with what was actually asked, so an example chip
      // leaves its text behind to edit and re-run.
      setQuestion(trimmed);
      setAsked(trimmed);

      // Reset before starting so the previous answer doesn't linger under a new
      // question — the most confusing possible state for the user to read.
      setAnswer("");
      setSources([]);
      setError(null);
      setFocusedSource(null);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // The whole streaming protocol, consumed as an ordinary loop. `switch`
        // on the discriminant means adding an event type server-side surfaces
        // here as a TypeScript error rather than a silently ignored message.
        for await (const event of streamAsk(
          token,
          { question: trimmed },
          controller.signal,
        )) {
          switch (event.type) {
            case "sources":
              // Arrives before any token: citations paint while the model is
              // still thinking, so the wait has something in it.
              setSources(event.sources);
              break;

            case "token":
              // Functional update, because tokens land faster than React
              // commits. `setAnswer(answer + value)` would read a stale `answer`
              // from this render's closure and drop characters — the classic
              // version of this bug, and one that only shows up under speed.
              setAnswer((prev) => prev + event.value);
              break;

            case "done":
              // The server's assembled answer is authoritative. Assigning it
              // repairs any drift between it and our token-by-token
              // accumulation, and costs nothing since they normally match.
              setAnswer(event.answer);
              break;

            case "error":
              // A failure AFTER the response headers went out, so it could not
              // be an HTTP status — see the streaming note in query.routes.ts.
              // Surfaced as an error rather than left as a truncated answer,
              // which would look indistinguishable from a complete one.
              setError(event.message);
              break;
          }
        }
      } catch (err) {
        // An abort is a user action, not a failure. Silently ignore it, and
        // keep whatever text already arrived on screen.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    // `question` is no longer a dependency — the text arrives as an argument,
    // so this callback stays referentially stable across every keystroke
    // instead of being rebuilt on each one.
    [streaming, token],
  );

  // Clicking a citation chip scrolls its source card into view and highlights
  // it. This is the payoff of the whole citation design: the claim and the
  // evidence are one click apart.
  const handleCitationClick = useCallback((n: number) => {
    setFocusedSource(n);

    const card = document.getElementById(`source-${n}`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });

    // Move focus too, not just the viewport. Scrolling is a purely visual
    // answer to "where is the evidence" — a screen reader user activating the
    // same chip got nothing at all, and a keyboard user's next Tab continued
    // from the citation instead of from the card they just jumped to. The card
    // carries tabIndex={-1} to be focusable without entering the tab order.
    //
    // `preventScroll` because the smooth scroll above is already in flight;
    // letting focus() scroll as well cancels it and lands with a jump.
    card?.focus({ preventScroll: true });
  }, []);

  if (status !== "authenticated" || !user || !token) return <PageLoading />;

  const hasResult = streaming || answer || sources.length > 0 || error;

  return (
    // `animate-rise` on the page container, so arriving on a route is a short
    // fade-and-lift rather than a hard swap. It runs on mount only — a
    // re-render doesn't recreate the element, so streaming tokens don't
    // retrigger it — and the global prefers-reduced-motion block already
    // collapses it to nothing for anyone who has asked for that.
    <div className="mx-auto w-full max-w-2xl flex-1 animate-rise px-4 py-10 sm:px-6">
      <PageHeader
        // Points at the landing page, not at Documents. Ask and Documents are
        // siblings — neither is "up" from the other, and the header nav already
        // moves between them — so the only honest destination for a back
        // control here is the level above both.
        back={{ href: "/", label: "Home" }}
        title="Ask"
        description="Answers are generated only from your documents, with citations you can open."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="mb-8"
      >
        {/* The input and its button share one bordered container rather than
            sitting side by side with a gap. `focus-within` moves the focus ring
            to that container, so the whole control lights up as a single object
            — which is what it is.

            `items-end`, so that as the textarea grows the button stays pinned
            to the bottom edge next to the last line rather than drifting to the
            vertical middle of a five-line box. */}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
          {/* `mt-3` centres the icon against the FIRST line (the 40px row minus
              the 16px icon, halved) instead of letting `items-end` drop it to
              the bottom of a grown box, where it would label nothing. */}
          <IconSearch className="mt-3 ml-2 size-4 shrink-0 self-start text-faint" />
          <textarea
            ref={inputRef}
            rows={1}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits, Shift+Enter breaks the line — the convention
              // every chat input has trained users into. Without this a
              // textarea silently downgrades the primary action from "press
              // Enter" to "go find the button".
              if (e.key !== "Enter" || e.shiftKey) return;

              // An IME (Japanese, Chinese, Korean) uses Enter to COMMIT the
              // candidate you're picking, and fires keydown for it while
              // composition is still open. Submitting there would send a
              // half-converted question and clear the box mid-word — a bug
              // invisible to anyone testing in English.
              if (e.nativeEvent.isComposing) return;

              e.preventDefault();
              ask(question);
            }}
            placeholder="What do your documents say about…?"
            maxLength={1000}
            disabled={streaming}
            aria-label="Your question"
            // `py-2` + `leading-6` makes a single line exactly 40px — the same
            // height as the md Button beside it — so the control doesn't change
            // shape between the empty state and the first character typed.
            //
            // `max-h-34` is the 5-line ceiling the auto-grow effect relies on:
            // it clamps the height assignment and hands over a scrollbar,
            // rather than the effect having to know the limit itself.
            //
            // The border/ring lives on the parent, so this strips its own
            // entirely — including the global :focus-visible outline, which
            // would otherwise draw a second ring inside the first.
            className="scrollbar-slim min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-fg max-h-34 placeholder:text-faint focus:outline-none focus-visible:outline-none disabled:text-muted"
          />
          {streaming ? (
            // Swapping Ask for Stop rather than showing both: while a stream is
            // running, stopping it is the only useful action.
            <Button onClick={stop} variant="secondary" className="shrink-0">
              <IconStop className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!question.trim()}
              className="shrink-0"
            >
              Ask
              <IconArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </form>

      {/* The blank slate. Only shown before the first question — once there's a
          result, re-offering examples would compete with the answer.

          Three states, and `loading` renders nothing on purpose: showing the
          example chips and then swapping them for "no documents yet" half a
          second later is worse than a beat of empty space.

          It does reserve the SPACE, though. Both resolved states are roughly
          this tall, so holding the height means the beat of emptiness stays
          empty instead of collapsing and then shoving the page back down when
          the request lands. Nothing is promised about what appears — which is
          the objection to a skeleton here — only that it appears in place. */}
      {!hasResult && library === "loading" && <div aria-hidden className="h-48" />}

      {!hasResult && library === "empty" && (
        <div className="animate-rise rounded-xl border border-dashed border-line px-6 py-10 text-center">
          <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-raised text-muted">
            <IconFile className="size-4.5" />
          </span>
          <p className="text-sm font-medium text-fg">Nothing to search yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
            Answers are built only from documents you add — so this page has nothing to
            work with until you add one. It takes about ten seconds.
          </p>
          {/* The input above stays enabled deliberately. This check runs once
              on mount, so it can be stale if a document was added in another
              tab — a disabled form would trap that user with no way out. */}
          <ButtonLink href="/documents" variant="primary" size="sm" className="mt-4">
            Add your first document
            <IconArrowRight className="size-4" />
          </ButtonLink>
        </div>
      )}

      {!hasResult && library === "stocked" && (
        <div className="animate-rise">
          <SectionHeading>Try asking</SectionHeading>
          <div className="flex flex-col gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => ask(example)}
                className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-sm text-muted shadow-sm transition-colors duration-150 hover:border-line-strong hover:text-fg"
              >
                <IconSpark className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-accent" />
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <Alert tone="error" className="mb-6">{error}</Alert>}

      {hasResult && (
        <>
          {/* `scroll-mt-20` for the same reason the source cards carry it: the
              scroll-into-view above aligns this section's top edge to the top
              of the viewport, which is underneath the sticky header. */}
          <section ref={answerRef} className="mb-8 scroll-mt-20">
            <SectionHeading>
              <IconSpark className="size-3.5" />
              Answer
            </SectionHeading>

            <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
              {asked && (
                <p className="mb-4 border-b border-line pb-3 text-[13px] text-muted">
                  {asked}
                </p>
              )}

              {/* Sources land before tokens, so there is a real window where
                  sources exist and the answer is still empty. Narrating that
                  window honestly — and naming which phase we're in — is better
                  than a blank box or a generic spinner. */}
              {!answer && streaming ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="size-3.5" />
                  {sources.length === 0
                    ? "Searching your documents…"
                    : `Reading ${sources.length} passage${sources.length === 1 ? "" : "s"}…`}
                </p>
              ) : (
                <AnswerView
                  answer={answer}
                  sources={sources}
                  streaming={streaming}
                  onCitationClick={handleCitationClick}
                />
              )}
            </div>
          </section>

          {sources.length > 0 && (
            <section>
              <SectionHeading
                aside={
                  <span className="text-xs text-faint tabular-nums">
                    top {sources.length} by cosine similarity
                  </span>
                }
              >
                <IconLayers className="size-3.5" />
                Sources
              </SectionHeading>
              <SourceList sources={sources} focused={focusedSource} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
