"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, streamAsk, type Source } from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AnswerView } from "@/components/AnswerView";
import { SourceList } from "@/components/SourceList";
import { PageHeader } from "@/components/AppShell";
import { PageLoading } from "@/components/ui/PageLoading";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { SectionHeading } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { IconArrowRight, IconLayers, IconSearch, IconSpark, IconStop } from "@/components/icons";

// Starter questions for an empty page. A blank input with no prompt is the
// hardest possible first interaction — these are generic enough to work against
// any corpus, and clicking one submits immediately rather than just filling the
// box, because a second click to confirm is pure friction.
const EXAMPLES = [
  "Summarise the key points across my documents.",
  "What decisions were made, and why?",
  "What does this say about pricing?",
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

  // In a ref, not state: aborting must not trigger a render, and the handler
  // needs to reach the CURRENT controller. A state value would be captured by
  // the closure at the render that created it, so "Stop" could end up aborting
  // a request that already finished.
  const abortRef = useRef<AbortController | null>(null);

  // Abort on unmount. Navigating away mid-answer should stop the server
  // generating (and stop us paying for) tokens nobody will read — the api wires
  // this abort straight through to the OpenAI request. Without it, `setAnswer`
  // would also fire on an unmounted component.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

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
    document
      .getElementById(`source-${n}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  if (status !== "authenticated" || !user || !token) return <PageLoading />;

  const hasResult = streaming || answer || sources.length > 0 || error;

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader
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
            — which is what it is. */}
        <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15">
          <IconSearch className="ml-2 size-4 shrink-0 text-faint" />
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What do your documents say about…?"
            maxLength={1000}
            disabled={streaming}
            aria-label="Your question"
            // The border/ring lives on the parent, so this strips its own
            // entirely — including the global :focus-visible outline, which
            // would otherwise draw a second ring inside the first.
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none disabled:text-muted"
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
          result, re-offering examples would compete with the answer. */}
      {!hasResult && (
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
          <section className="mb-8">
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
