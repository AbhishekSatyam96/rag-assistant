"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getConversation,
  listConversations,
  listDocuments,
  streamChat,
  type ChatMessage,
  type ConversationSummary,
  type Source,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useSpeech } from "@/lib/use-speech";
import { PageHeader } from "@/components/AppShell";
import { ChatComposer } from "@/components/ChatComposer";
import { ConversationList } from "@/components/ConversationList";
import { AnswerBlock, QuestionBubble, type SearchInfo } from "@/components/ChatTurn";
import { Alert } from "@/components/ui/Alert";
import { ButtonLink } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/Card";
import { PageLoading } from "@/components/ui/PageLoading";
import { Spinner } from "@/components/ui/Spinner";
import { IconArrowRight, IconFile, IconSpark } from "@/components/icons";

// The chat surface, shared by /chat (a new thread) and /chat/[id] (an existing
// one).
//
// ONE COMPONENT FOR BOTH ROUTES, and that is what makes the new-thread flow
// work. When the first answer starts streaming the server mints a conversation
// id, and the URL has to change to match — but `router.push("/chat/" + id)`
// would unmount this component and remount the [id] page, throwing away the
// stream in progress. So the URL is updated with `history.replaceState`, which
// changes the address bar without a Next.js navigation, and the same mounted
// component keeps streaming. A later refresh then lands on /chat/[id] and loads
// the thread from the server, which is the state the URL always described.
//
// `replaceState`, not `pushState`: the empty /chat page is not somewhere Back
// should return you to.

const EXAMPLES = [
  "Summarise the key points across my documents.",
  "What are the main topics covered?",
  "List anything that looks like a rule, limit or deadline.",
];

export function ChatView({ conversationId: initialId }: { conversationId?: string }) {
  const { user, token, status } = useRequireAuth();

  // Reading answers aloud. Owned here rather than in the composer because only
  // this component sees the token stream, and speaking has to start BEFORE the
  // stream finishes — the same instinct as emitting sources before the first
  // token: do not make the user wait out the slow part for the fast feedback.
  const speech = useSpeech();

  // Null until a thread exists. On /chat it is filled in by the `conversation`
  // event; on /chat/[id] it is known from the route.
  const [conversationId, setConversationId] = useState<string | null>(initialId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadStatus, setThreadStatus] = useState<"loading" | "ready" | "missing">(
    initialId ? "loading" : "ready",
  );

  // The composer's text, and separately the question the in-flight turn belongs
  // to. Two values because the box keeps changing as you type, and reusing it
  // would silently re-caption an answer that came from something else.
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [search, setSearch] = useState<SearchInfo | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which citation chip was last clicked, namespaced by message — a thread has
  // many source lists and each numbers itself from 1.
  const [focused, setFocused] = useState<{ domId: string; n: number } | null>(null);

  // What the rewrite step did, per assistant message. Session-only: the server
  // stores the answer and its citations but not the query it searched with, so
  // this is gone after a reload. A deliberate stopping point rather than an
  // oversight — persisting it means another column, and its value is explaining
  // the answer you are watching arrive.
  const [searchByMessage, setSearchByMessage] = useState<Record<string, SearchInfo>>({});

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  // Does this account have anything to search at all?
  //
  // Without this check the first run of a brand-new account is: sign up, ask,
  // and get a correct, honest "your documents don't contain that" — which is
  // indistinguishable from a broken product. The refusal is the feature, so the
  // fix is not to soften it; it is to never let someone meet it before they have
  // added anything.
  const [library, setLibrary] = useState<"loading" | "empty" | "stocked">("loading");

  // In a ref, not state: aborting must not trigger a render, and the handler
  // needs to reach the CURRENT controller. A state value would be captured by
  // the closure at the render that created it, so Stop could end up aborting a
  // request that already finished.
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Abort on unmount. Navigating away mid-answer should stop the server
  // generating (and stop us paying for) tokens nobody will read — the api wires
  // this abort straight through to the OpenAI request.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Load an existing thread.
  useEffect(() => {
    if (!token || !initialId) return;
    let cancelled = false;

    getConversation(token, initialId)
      .then(({ conversation }) => {
        if (cancelled) return;
        setMessages(conversation.messages);
        setThreadStatus("ready");
      })
      .catch(() => {
        // A 404 here means deleted, or never yours. Both render the same "not
        // found" screen, for the same reason the api answers 404 rather than
        // 403: distinguishing them would confirm the id exists.
        if (!cancelled) setThreadStatus("missing");
      });

    return () => {
      cancelled = true;
    };
  }, [token, initialId]);

  // Recent threads and the library check, only on the new-conversation page —
  // inside a thread neither is on screen, and fetching them would be two
  // requests to render nothing.
  useEffect(() => {
    if (!token || initialId) return;
    let cancelled = false;

    listConversations(token, { limit: 8 })
      .then(({ conversations: rows }) => {
        if (!cancelled) setConversations(rows);
      })
      .catch(() => {
        // Silent. This list is a convenience; failing to load it should not put
        // an error banner above a composer that works perfectly well.
      });

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
        // have none" screen — because one list request timed out — is far worse
        // than showing the normal page.
        if (!cancelled) setLibrary("stocked");
      });

    return () => {
      cancelled = true;
    };
  }, [token, initialId]);

  // --- scrolling -------------------------------------------------------------

  // Whether the view should follow new tokens. Flipped by the user's own
  // scrolling: reading back through a long answer while the model is still
  // writing must not yank you to the bottom every 50ms. In a ref rather than
  // state because it changes on every scroll event and nothing renders from it.
  const stickToBottom = useRef(true);

  useEffect(() => {
    function onScroll() {
      const fromBottom =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      stickToBottom.current = fromBottom < 120;
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A new question always scrolls, whatever the user was reading — they just
  // asked it, so it is where their attention is.
  useEffect(() => {
    if (!asked) return;
    stickToBottom.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [asked]);

  // Following tokens is deliberately NOT smooth. A smooth scroll takes a few
  // hundred milliseconds and tokens arrive faster than that, so each one
  // interrupts the last and the page crawls behind the text it is chasing.
  useEffect(() => {
    if (!streaming || !stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [answer, streaming]);

  // --- actions ---------------------------------------------------------------

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Stop means stop. Leaving the browser to finish reading three queued
    // sentences after the user has visibly halted the answer is the loudest
    // possible way to look broken.
    speech.cancel();
  }, [speech]);

  const ask = useCallback(
    async (raw: string) => {
      if (!token || streaming) return;

      const trimmed = raw.trim();
      if (!trimmed) return;

      // Before anything else: kill the previous answer's audio and put the
      // sentence counter back to zero. A new question is a new turn.
      speech.reset();

      setQuestion("");
      setAsked(trimmed);
      setAnswer("");
      setSources([]);
      setSearch(null);
      setError(null);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Accumulated in LOCALS as well as in state, because the commit below runs
      // in a `finally` where reading state would give this render's stale
      // closure. The state copies drive the live UI; these drive what gets
      // appended to the transcript.
      let finalAnswer = "";
      let finalSources: Source[] = [];
      let finalSearch: SearchInfo | null = null;
      let userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();

      try {
        for await (const event of streamChat(
          token,
          { conversationId: conversationId ?? undefined, question: trimmed },
          controller.signal,
        )) {
          switch (event.type) {
            case "conversation":
              userMessageId = event.messageId;
              // Adopt the id and correct the URL, without a Next navigation —
              // see the note at the top of this file. Only on a brand-new
              // thread; continuing one changes nothing.
              if (!conversationId) {
                setConversationId(event.conversationId);
                window.history.replaceState(null, "", `/chat/${event.conversationId}`);
              }
              break;

            case "search":
              finalSearch = event;
              setSearch(event);
              break;

            case "sources":
              // Arrives before any token: citations paint while the model is
              // still thinking, so the wait has something in it.
              finalSources = event.sources;
              setSources(event.sources);
              break;

            case "token":
              finalAnswer += event.value;
              // Functional update, because tokens land faster than React
              // commits. `setAnswer(answer + value)` would read a stale `answer`
              // from this render's closure and drop characters — a bug that only
              // shows up under speed.
              setAnswer((prev) => prev + event.value);
              // Fed the LOCAL accumulator, not the state, for exactly the same
              // reason: this closure's `answer` is a render behind. `push` is
              // cheap on a token that cannot have completed a sentence, and
              // holds back the trailing fragment until it is safe to speak —
              // see lib/speech.ts.
              speech.push(finalAnswer, false);
              break;

            case "done":
              // The server's assembled answer is authoritative. Assigning it
              // repairs any drift with our token-by-token accumulation, and
              // costs nothing since they normally match.
              finalAnswer = event.answer;
              setAnswer(event.answer);
              // `final` flushes the held-back last sentence, which otherwise
              // never gets spoken — the most-reported bug shape for anything
              // built on a buffer-and-flush.
              speech.push(event.answer, true);
              break;

            case "error":
              // A failure AFTER the response headers went out, so it could not
              // be an HTTP status. Surfaced as an error rather than left as a
              // truncated answer, which would look indistinguishable from a
              // complete one.
              setError(event.message);
              break;
          }
        }
      } catch (err) {
        // An abort is a user action, not a failure. Whatever text arrived stays
        // on screen, and the commit below still runs — the server kept the
        // partial answer too, so throwing it away here would put the client out
        // of step with the transcript on reload.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof ApiError ? err.message : "Something went wrong.");
        }
      } finally {
        // Move the finished exchange into the transcript and clear the live
        // slots. Doing it here rather than in the `done` case means an aborted
        // or failed turn is committed too, which is what keeps the on-screen
        // thread identical to what a reload would fetch.
        const now = new Date().toISOString();

        setMessages((prev) => [
          ...prev,
          {
            id: userMessageId,
            role: "USER",
            content: trimmed,
            sources: [],
            seq: prev.length + 1,
            createdAt: now,
          },
          // An answer that never produced a character is not written server-side
          // either — an empty reply bubble reads as a bug, while an unanswered
          // question is what actually happened.
          ...(finalAnswer
            ? [
                {
                  id: assistantMessageId,
                  role: "ASSISTANT" as const,
                  content: finalAnswer,
                  sources: finalSources,
                  seq: prev.length + 2,
                  createdAt: now,
                },
              ]
            : []),
        ]);

        // Copied to a const first. `finalSearch` is a captured `let`, so
        // TypeScript will not carry the null-check into the updater closure —
        // it has no way to know the variable is not reassigned before the
        // closure runs.
        const committedSearch = finalSearch;
        if (finalAnswer && committedSearch) {
          setSearchByMessage((prev) => ({ ...prev, [assistantMessageId]: committedSearch }));
        }

        setAsked(null);
        setAnswer("");
        setSources([]);
        setSearch(null);
        setStreaming(false);
        abortRef.current = null;
      }
    },
    // `speech` is a memoised object from useSpeech, so adding it here does not
    // rebuild this callback per keystroke — which was the property the original
    // dependency list was chosen to preserve.
    [conversationId, speech, streaming, token],
  );

  const handleCitationClick = useCallback((domId: string, n: number) => {
    setFocused({ domId, n });

    const card = document.getElementById(`${domId}-${n}`);
    if (!card) return;

    // Source lists are collapsed by default in a thread, so the card exists in
    // the DOM but is not rendered — scrollIntoView on it would do nothing and
    // the chip would look broken. Opening the enclosing <details> first is the
    // whole fix. Set imperatively rather than via state because the element is
    // uncontrolled, so React has no opinion to fight with.
    card.closest("details")?.setAttribute("open", "");

    card.scrollIntoView({ behavior: "smooth", block: "center" });

    // Move focus too, not just the viewport. Scrolling is a purely visual answer
    // to "where is the evidence" — a screen reader user activating the same chip
    // got nothing at all. `preventScroll` because the smooth scroll above is
    // already in flight; letting focus() scroll as well cancels it.
    card.focus({ preventScroll: true });
  }, []);

  const handleDeleted = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // --- render ----------------------------------------------------------------

  if (status !== "authenticated" || !user || !token) return <PageLoading />;
  if (threadStatus === "loading") return <PageLoading label="Loading conversation" />;

  if (threadStatus === "missing") {
    return (
      <div className="mx-auto w-full max-w-2xl flex-1 animate-rise px-4 py-10 sm:px-6">
        <PageHeader
          back={{ href: "/chat", label: "Chat" }}
          title="Conversation not found"
          description="It may have been deleted, or the link may be wrong."
        />
      </div>
    );
  }

  const empty = messages.length === 0 && !asked;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-10 sm:px-6">
      <PageHeader
        // On a thread, "up" is the chat index. On the index, it is the level
        // above Chat and Ask both — neither is up from the other, and the header
        // nav already moves between them.
        back={conversationId ? { href: "/chat", label: "Chat" } : { href: "/", label: "Home" }}
        title="Chat"
        description="Ask follow-up questions. Every answer is still built only from your documents, with citations you can open."
      />

      {/* The transcript. `flex-1` so the composer below is pushed to the bottom
          of the viewport on a short thread instead of floating mid-page. */}
      <div className="flex flex-1 flex-col gap-6">
        {messages.map((message) =>
          message.role === "USER" ? (
            <QuestionBubble key={message.id} text={message.content} />
          ) : (
            <AnswerBlock
              key={message.id}
              domId={`src-${message.id}`}
              answer={message.content}
              sources={message.sources}
              search={searchByMessage[message.id] ?? null}
              streaming={false}
              focused={focused?.domId === `src-${message.id}` ? focused.n : null}
              onCitationClick={(n) => handleCitationClick(`src-${message.id}`, n)}
            />
          ),
        )}

        {/* The in-flight exchange, held outside `messages` so a token updates one
            string rather than rebuilding the whole array. */}
        {asked && (
          <>
            <QuestionBubble text={asked} />
            <AnswerBlock
              domId="src-live"
              answer={answer}
              sources={sources}
              search={search}
              streaming={streaming}
              focused={focused?.domId === "src-live" ? focused.n : null}
              onCitationClick={(n) => handleCitationClick("src-live", n)}
            />
          </>
        )}

        {empty && library === "empty" && (
          <div className="animate-rise rounded-xl border border-dashed border-line px-6 py-10 text-center">
            <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-raised text-muted">
              <IconFile className="size-4.5" />
            </span>
            <p className="text-sm font-medium text-fg">Nothing to search yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
              Answers are built only from documents you add — so this page has nothing to
              work with until you add one. It takes about ten seconds.
            </p>
            {/* The composer stays enabled deliberately. This check runs once on
                mount, so it can be stale if a document was added in another tab
                — a disabled form would trap that user with no way out. */}
            <ButtonLink href="/documents" variant="primary" size="sm" className="mt-4">
              Add your first document
              <IconArrowRight className="size-4" />
            </ButtonLink>
          </div>
        )}

        {empty && library === "stocked" && (
          <div className="animate-rise">
            <SectionHeading>Try asking</SectionHeading>
            <div className="flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  // Submits immediately rather than only filling the box: a
                  // second click to confirm is pure friction.
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

        {/* Three library states, and `loading` renders nothing on purpose:
            showing suggestions and swapping them for "no documents yet" half a
            second later is worse than a beat of empty space. */}
        {empty && library === "loading" && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Spinner className="size-3.5" />
            Checking your library…
          </p>
        )}

        {empty && conversations.length > 0 && (
          <div className="animate-rise">
            <SectionHeading>Recent</SectionHeading>
            <ConversationList
              token={token}
              conversations={conversations}
              onDeleted={handleDeleted}
            />
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}

        {/* The scroll anchor. An empty element rather than scrolling the last
            message, because the last message's height changes on every token —
            a fixed anchor below everything is stable. */}
        <div ref={bottomRef} aria-hidden />
      </div>

      {/* `sticky bottom-0` keeps the composer reachable in a long thread without
          taking it out of flow, so it never overlaps the final answer. The
          gradient hides text sliding under it rather than letting it collide
          with the input's border. */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-6 bg-linear-to-t from-canvas via-canvas to-transparent px-4 pt-4 pb-4 sm:-mx-6 sm:px-6">
        <ChatComposer
          value={question}
          onChange={setQuestion}
          onSubmit={ask}
          onStop={stop}
          streaming={streaming}
          token={token}
          speech={speech}
          autoFocus
          placeholder={
            messages.length > 0 ? "Ask a follow-up…" : "What do your documents say about…?"
          }
        />
      </div>
    </div>
  );
}
