"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, streamAsk, type Source } from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AnswerView } from "@/components/AnswerView";
import { SourceList } from "@/components/SourceList";

export default function AskPage() {
  const { user, token, status, logout } = useRequireAuth();

  const [question, setQuestion] = useState("");
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

  const ask = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!token || streaming) return;

      const trimmed = question.trim();
      // Mirrors the server's zod rule. Client validation here is UX only — it
      // saves a round-trip; the server's copy is the one that's load-bearing.
      if (!trimmed) return;

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
    [question, streaming, token],
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

  if (status !== "authenticated" || !user || !token) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      </div>
    );
  }

  const hasResult = streaming || answer || sources.length > 0 || error;

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ask</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Answers are generated only from your documents, with citations.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
          <span className="text-black/50 dark:text-white/50">{user.email}</span>
          <div className="flex gap-3">
            <Link href="/documents" className="underline underline-offset-4">
              Documents
            </Link>
            <button onClick={logout} className="underline underline-offset-4">
              Log out
            </button>
          </div>
        </div>
      </header>

      <form onSubmit={ask} className="mb-8">
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What do your documents say about…?"
            maxLength={1000}
            disabled={streaming}
            className="min-w-0 flex-1 rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-black/40 disabled:opacity-60 dark:border-white/15 dark:focus:border-white/40"
          />
          {streaming ? (
            // Swapping Ask for Stop rather than showing both: while a stream is
            // running, stopping it is the only useful action.
            <button
              type="button"
              onClick={stop}
              className="shrink-0 rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/15"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!question.trim()}
              className="shrink-0 rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              Ask
            </button>
          )}
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="mb-6 rounded-md bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {hasResult && (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold">Answer</h2>
            {/* Sources land before tokens, so there is a real window where
                sources exist and the answer is still empty. Showing "Searching…"
                then "Reading your documents…" narrates it honestly instead of
                leaving a blank box. */}
            {!answer && streaming ? (
              <p className="text-sm text-black/50 dark:text-white/50">
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
          </section>

          {sources.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold">
                Sources{" "}
                <span className="font-normal text-black/40 dark:text-white/40">
                  ({sources.length})
                </span>
              </h2>
              <SourceList sources={sources} focused={focusedSource} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
