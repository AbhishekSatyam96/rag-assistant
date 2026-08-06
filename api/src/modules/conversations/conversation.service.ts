import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/http-error.js";
import { retrieveChunks } from "../../lib/retrieve.js";
import { streamAnswer } from "../../lib/answer.js";
import { condense, type HistoryTurn } from "../../lib/condense.js";
import { toSource, type QueryEvent, type Source } from "../queries/query.service.js";
import { DEFAULT_PAGE_SIZE, titleFromQuestion } from "./conversation.schema.js";

// The multi-turn read path: rewrite → retrieve (or re-use) → ground → generate →
// persist.
//
// It sits ALONGSIDE queries/query.service.ts rather than replacing it. That
// split is deliberate and worth defending: /queries is the single-turn endpoint
// the M7 eval harness scores, and inserting a rewrite step upstream of retrieval
// there would mean hit-rate@k silently measures "retrieval + rewrite" while
// still being read as "retrieval". Two entry points, one set of primitives —
// retrieveChunks, streamAnswer and condense are shared, so the thing being
// measured is the thing users hit.
//
// Like its sibling, this yields typed EVENTS and never touches `res`.

// --- events ------------------------------------------------------------------

export type ConversationEvent =
  // Always first. Carries the id the client needs to put in the URL, which is
  // why it is emitted before any slow work rather than at the end.
  | {
      type: "conversation";
      conversationId: string;
      title: string;
      messageId: string;
    }
  // What we actually searched for, and why. Emitted because the rewrite is
  // otherwise invisible magic: "How long is it?" quietly becoming "How long is
  // parental leave under the handbook?" is the single most surprising thing this
  // feature does, and a user who cannot see it has no way to tell a bad rewrite
  // from bad retrieval.
  | { type: "search"; query: string; rewritten: boolean; reused: boolean }
  // sources | token | done | error, identical to the single-turn path. Reusing
  // the union rather than redeclaring it means a new event type added there
  // breaks the exhaustive switch in BOTH clients.
  | QueryEvent;

// --- reading -----------------------------------------------------------------

const conversationSelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConversationSelect;

export type ConversationSummary = Prisma.ConversationGetPayload<{
  select: typeof conversationSelect;
}>;

export type ConversationPage = {
  conversations: ConversationSummary[];
  nextCursor: string | null;
};

type StoredMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  sources: Source[];
  seq: number;
  createdAt: Date;
};

export type ConversationDetail = ConversationSummary & {
  messages: StoredMessage[];
};

// `sources` is a Json column, so what comes back is Prisma.JsonValue — which is
// to say, unknown. This cast is unchecked in exactly the way `$queryRaw`'s row
// type is: nothing verifies that the shape written last week matches the Source
// type compiled today.
//
// The mitigation is the same one used there — keep the assertion next to the
// only place that writes the column (persistAnswer, below), so a change to
// Source is one file away from the code that has to migrate for it. The
// Array.isArray guard means the worst case is a message rendering with no
// citations, not a crash.
function parseSources(value: Prisma.JsonValue | null): Source[] {
  if (!Array.isArray(value)) return [];
  return value as unknown as Source[];
}

export async function listConversations({
  userId,
  limit = DEFAULT_PAGE_SIZE,
  cursor,
}: {
  userId: string;
  limit?: number;
  cursor?: string;
}): Promise<ConversationPage> {
  // Resolve the cursor against THIS user first, rather than handing it straight
  // to Prisma. Same reasoning as listDocuments: a cursor naming a row the WHERE
  // clause excludes does not throw, it resolves to an empty page — which renders
  // as "you have no conversations" for a user holding a stale cursor. Resolving
  // it first means an unrecognised cursor falls back to page one, while the two
  // failure cases still return byte-identical responses so the endpoint can't be
  // used as an oracle for whether an id exists.
  const cursorRow = cursor
    ? await prisma.conversation.findFirst({
        where: { id: cursor, userId },
        select: { id: true },
      })
    : null;

  // One row more than asked for: if it comes back there is a next page, which
  // answers "is there more" using the query already in flight instead of a
  // second COUNT(*).
  const rows = await prisma.conversation.findMany({
    where: { userId },
    // Ordered by ACTIVITY, not creation — a thread you replied to five minutes
    // ago belongs at the top even if you started it last week. `id` is the
    // tiebreak, because two threads can share an updatedAt and pagination over a
    // non-total order silently skips and repeats rows.
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: conversationSelect,
    take: limit + 1,
    // `skip: 1` skips the cursor row itself; without it every page after the
    // first opens with a duplicate of the previous page's last item.
    ...(cursorRow ? { cursor: { id: cursorRow.id }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const conversations = hasMore ? rows.slice(0, limit) : rows;

  return {
    conversations,
    nextCursor: hasMore ? conversations[conversations.length - 1].id : null,
  };
}

export async function getConversation({
  userId,
  id,
}: {
  userId: string;
  id: string;
}): Promise<ConversationDetail> {
  // Ownership lives in the WHERE clause — never a findUnique followed by an
  // `if`. 404 rather than 403 for someone else's thread, because a 403 confirms
  // the id exists and lets an attacker enumerate ids to map another tenant's
  // history. Both 404s are byte-identical so the message cannot become an
  // oracle.
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId },
    select: conversationSelect,
  });

  if (!conversation) throw new HttpError(404, "Conversation not found");

  const messages = await loadMessages(id);

  return { ...conversation, messages };
}

export async function deleteConversation({
  userId,
  id,
}: {
  userId: string;
  id: string;
}): Promise<void> {
  // deleteMany, not delete: `delete` throws P2025 when nothing matches, so the
  // "not mine" and "does not exist" cases would need to be caught and
  // re-thrown anyway. deleteMany reports a count instead, and the count is the
  // 404 test. Messages go with it via onDelete: Cascade on the relation.
  const { count } = await prisma.conversation.deleteMany({ where: { id, userId } });
  if (count === 0) throw new HttpError(404, "Conversation not found");
}

async function loadMessages(conversationId: string): Promise<StoredMessage[]> {
  // No `userId` here, and that is safe rather than an oversight: every caller
  // has already resolved the conversation through a userId-scoped query, so this
  // is a lookup by a foreign key we have already proven belongs to the caller.
  const rows = await prisma.message.findMany({
    where: { conversationId },
    // `seq`, never `createdAt`. The question and its answer are frequently
    // written within the same millisecond, and ordering by a timestamp puts them
    // in an undefined order — which renders the answer above the question.
    orderBy: { seq: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      sources: true,
      seq: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({ ...row, sources: parseSources(row.sources) }));
}

// --- writing + streaming -----------------------------------------------------

// Turn stored rows into the shape the model prompts expect.
//
// The filter is the interesting part. A turn whose generation was aborted before
// the first token leaves a USER row with no ASSISTANT row after it — the thread
// legitimately contains an unanswered question, and the UI shows it as such. But
// handing the model two user messages in a row is confusing at best, so an
// unanswered question is dropped from the PROMPT while staying in the
// TRANSCRIPT. Those are different things and this is the line between them.
function toHistory(messages: StoredMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "ASSISTANT") {
      turns.push({ role: "assistant", content: message.content });
      continue;
    }

    if (messages[i + 1]?.role === "ASSISTANT") {
      turns.push({ role: "user", content: message.content });
    }
  }

  return turns;
}

// The citations of the most recent answer, which are what a `reuse` turn
// ("make that shorter") re-grounds against.
function lastAnswerSources(messages: StoredMessage[]): Source[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "ASSISTANT") return messages[i].sources;
  }
  return [];
}

type TurnInput = {
  userId: string;
  question: string;
  k: number;
  signal?: AbortSignal;
};

export async function* startConversation(
  input: TurnInput,
): AsyncGenerator<ConversationEvent> {
  // Generator bodies are LAZY — nothing here runs until the route pulls the
  // first value, which is what lets the route defer its response headers. A
  // failure creating this row therefore still happens while a real HTTP status
  // code is available. See the long comment in query.routes.ts.
  const conversation = await prisma.conversation.create({
    data: { userId: input.userId, title: titleFromQuestion(input.question) },
    select: { id: true, title: true },
  });

  yield* runTurn({
    ...input,
    conversation,
    history: [],
    previousSources: [],
    lastSeq: 0,
  });
}

export async function* continueConversation({
  conversationId,
  ...input
}: TurnInput & { conversationId: string }): AsyncGenerator<ConversationEvent> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: input.userId },
    select: { id: true, title: true },
  });

  if (!conversation) throw new HttpError(404, "Conversation not found");

  const messages = await loadMessages(conversationId);

  yield* runTurn({
    ...input,
    conversation,
    history: toHistory(messages),
    previousSources: lastAnswerSources(messages),
    lastSeq: messages.length > 0 ? messages[messages.length - 1].seq : 0,
  });
}

async function* runTurn({
  userId,
  question,
  k,
  signal,
  conversation,
  history,
  previousSources,
  lastSeq,
}: TurnInput & {
  conversation: { id: string; title: string };
  history: HistoryTurn[];
  previousSources: Source[];
  lastSeq: number;
}): AsyncGenerator<ConversationEvent> {
  const userMessage = await appendUserMessage({
    conversationId: conversation.id,
    question,
    seq: lastSeq + 1,
  });

  // FIRST YIELD — and therefore the point where the response status is committed
  // to 200 and any later failure has to travel in-band as an `error` event.
  //
  // Emitting it here rather than after retrieval is a deliberate trade, because
  // it costs the clean HTTP status a retrieval failure would otherwise get. The
  // reason it still wins: by this line a conversation row and a message row
  // exist in the database. Failing with a 500 and no id would leave the client
  // unaware of persisted state it owns — a thread with a question in it and no
  // way to navigate there. Telling the client about a resource that genuinely
  // exists is the honest move, and the `error` event was built for exactly the
  // failures that follow.
  yield {
    type: "conversation",
    conversationId: conversation.id,
    title: conversation.title,
    messageId: userMessage.id,
  };

  // THE REWRITE. See lib/condense.ts for why a follow-up cannot be embedded as
  // typed. No-ops on the first turn without a model call.
  const condensed = await condense({ history, question, signal });

  // `reuse` needs something to re-use. It should always have it — condense only
  // returns `reuse` when history is non-empty, and non-empty history implies a
  // previous answer — but "should always" is not "does", and the fallback here
  // is free: search for what the user literally typed, which is what the app did
  // before this feature existed.
  const reused = condensed.kind === "reuse" && previousSources.length > 0;
  const searchQuery = condensed.kind === "search" ? condensed.question : question;

  const sources = reused
    ? previousSources
    : (await retrieveChunks({ userId, question: searchQuery, k })).map(toSource);

  yield {
    type: "search",
    query: searchQuery,
    rewritten: condensed.kind === "search" && condensed.rewritten,
    reused,
  };

  // Before any token, same as the single-turn path: retrieval is fast and
  // generation is slow, so citations fill the screen during the part of the wait
  // the user actually feels.
  yield { type: "sources", sources };

  let answer = "";
  let persisted = false;

  try {
    // `question` — the user's ORIGINAL words — not `searchQuery`. The rewrite
    // exists to make retrieval work; answering it instead would turn "make that
    // shorter" into a re-answer of a question nobody asked.
    //
    // `sources` passes straight in as context because Source structurally
    // satisfies ContextChunk. That is what lets the fresh-retrieval and re-use
    // paths share one call with no adapter between them.
    for await (const value of streamAnswer({
      question,
      chunks: sources,
      history,
      // On a re-use turn these chunks ARE the previous answer's sources, so its
      // citation markers still resolve and must survive into the prompt.
      citationsCarryOver: reused,
      signal,
    })) {
      answer += value;
      yield { type: "token", value };
    }

    yield { type: "done", answer };
  } finally {
    // WHY THIS IS IN A `finally`.
    //
    // When the user hits Stop, the route's abort fires and `for await` calls
    // .return() on this generator — which runs `finally` and nothing else. A
    // plain save after the loop would never execute, and the thread would be
    // left holding a question whose answer was thrown away. The next turn would
    // then send the model two user messages in a row.
    //
    // So a partial answer is kept, exactly as ChatGPT does. A user who stops
    // generation still wanted the words that arrived.
    if (!persisted) {
      persisted = true;
      // Swallowing failures here is not laziness: an exception raised inside a
      // `finally` REPLACES whatever was propagating, so a database hiccup during
      // cleanup would erase the real error — including the abort that got us
      // here — and surface as something unrelated.
      await persistAnswer({
        conversationId: conversation.id,
        seq: lastSeq + 2,
        answer,
        sources,
      }).catch((err) => {
        console.error("[conversations] failed to persist assistant message:", err);
      });
    }
  }
}

async function appendUserMessage({
  conversationId,
  question,
  seq,
}: {
  conversationId: string;
  question: string;
  seq: number;
}): Promise<{ id: string }> {
  try {
    // A transaction, because two rows must move together: the message, and the
    // conversation's updatedAt that orders the sidebar. `updatedAt` is set
    // explicitly rather than relying on @updatedAt, because @updatedAt only
    // fires on an actual update of that row and nothing else here touches it.
    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId, role: "USER", content: question, seq },
        select: { id: true },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
        select: { id: true },
      }),
    ]);

    return message;
  } catch (err) {
    // P2002 on (conversationId, seq) means another request claimed this position
    // first — two browser tabs posting into the same thread. The unique index is
    // doing precisely its job: without it both writes succeed and the transcript
    // silently interleaves two conversations into one unreadable thread.
    //
    // 409, not 500: nothing is broken, the client's view of the thread is simply
    // stale, and retrying after a refetch will work.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(
        409,
        "This conversation moved on in another tab. Refresh to see the latest messages.",
        { cause: err },
      );
    }
    throw err;
  }
}

async function persistAnswer({
  conversationId,
  seq,
  answer,
  sources,
}: {
  conversationId: string;
  seq: number;
  answer: string;
  sources: Source[];
}): Promise<void> {
  // Nothing arrived — an abort before the first token, or a generation failure.
  // Writing an empty ASSISTANT row would render as a blank reply bubble, which
  // reads as a bug; leaving the question unanswered is what actually happened,
  // and toHistory() above already knows how to handle that shape.
  if (!answer.trim()) return;

  await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: answer,
      seq,
      // The snapshot. See the comment on Message.sources in schema.prisma for
      // why these are copied rather than referenced — chunks are deleted and
      // recreated as the library changes, and a citation is a claim about what
      // the answer was built from at the time it was given.
      sources: sources as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
}
