import { openai } from "./openai.js";
import { env } from "./env.js";

// Turning a follow-up into something you can actually search with.
//
// THE PROBLEM THIS SOLVES. Retrieval embeds the user's words and compares that
// vector against the corpus. In a single-turn app that works because the
// question is self-contained. In a conversation it stops working immediately:
//
//   Q1  "What does the handbook say about parental leave?"
//   Q2  "How long is it?"
//
// "How long is it?" embeds to a vector about duration and pronouns. It is not
// close to any passage about parental leave, so retrieval returns junk, the
// grounded prompt correctly refuses, and the product looks broken while every
// component behaved exactly as designed. The fix is a rewrite step: the model
// sees the conversation and produces "How long is parental leave under the
// handbook?", and THAT is what gets embedded.
//
// THE SECOND PROBLEM, which is less obvious and bites harder in a demo. Some
// follow-ups are not questions about the documents at all:
//
//   Q3  "Make that shorter."
//   Q4  "Explain it like I'm five."
//
// There is no standalone question hiding in "make that shorter" — rewriting it
// produces nonsense, and searching for it retrieves whatever the corpus's least
// relevant chunks happen to be. These are instructions about the ANSWER, and the
// right move is to skip retrieval entirely and re-use the previous turn's
// sources. That is what the `reuse` result means.
//
// Transport-free like its neighbours: no HTTP, no Prisma, no Express. It takes
// strings and returns a decision.

// How many previous messages the rewriter is allowed to see.
//
// 6 = three exchanges. Enough for "it"/"that"/"the second one" to resolve, and
// small enough that this stays a cheap call regardless of how long the thread
// grows. A rewriter given the entire conversation gets slower and more expensive
// forever, and is no better at resolving a pronoun that was introduced two
// messages ago.
const HISTORY_TURNS = 6;

// Assistant answers are truncated before the rewriter sees them. It needs enough
// to know what "the second one" referred to, not the whole essay — and an
// untruncated answer is by far the largest thing that would go into this prompt.
const ASSISTANT_PREVIEW_CHARS = 500;

// The sentinel the model emits for "this needs no new search". A distinctive
// all-caps token rather than an empty response, because an empty response is
// also what a failed call produces, and those two must not be confusable.
const NO_SEARCH = "NO_SEARCH";

// A rewritten question is a question. Anything much longer than the input cap on
// a real question means the model ignored the instruction and started answering
// instead — a well-documented failure of small models on rewrite tasks. Rather
// than feed that into the embedder, we fall back to the raw follow-up.
const MAX_REWRITE_CHARS = 400;

export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type CondenseResult =
  // Retrieve using `question`. `rewritten` says whether the rewriter actually
  // changed anything, which the UI surfaces ("Searched for: …") and the eval
  // harness will need in order to score this step separately from retrieval.
  | { kind: "search"; question: string; rewritten: boolean }
  // Skip retrieval; re-use the previous turn's sources.
  | { kind: "reuse" };

// Written as a constant and diffable in review, same reasoning as the system
// prompt in answer.ts: prompts are logic, and the highest-churn logic in a RAG
// app at that.
//
// Each instruction defends against a specific observed failure:
//   1 — the model answering the question instead of rewriting it.
//   2 — the model "improving" a question that was already fine, which changes
//       the embedding for no reason and can make retrieval worse.
//   3 — the reuse case above.
//   4 — commentary, quotes and "Sure! Here's the rewritten question:" preambles,
//       all of which end up in the embedding if they survive.
const SYSTEM_PROMPT = `You rewrite the final user message of a conversation into a standalone search query for a document retrieval system.

Rules:
1. Output ONLY the rewritten query. No preamble, no explanation, no quotation marks.
2. If the final message is already self-contained, output it unchanged.
3. If the final message is an instruction about the previous answer rather than a request for new information (for example "make it shorter", "explain it more simply", "rewrite that as bullets", "thanks"), output exactly: ${NO_SEARCH}
4. Resolve pronouns and references ("it", "that", "the second one") using the conversation, so the query makes sense on its own to someone who has not read it.`;

// The model writes "[2]" into its answers, and those numbers refer to a source
// list that belonged to ONE turn. Replaying them into a later prompt invites the
// model to reuse a numbering that no longer means anything — turn 3 has its own
// source 2, pointing at a different passage. History is here to resolve
// pronouns, not to carry citations, so the markers come out.
//
// Exported because answer.ts needs the identical treatment for the generation
// prompt, and two copies of this regex would be two things to keep in step.
export function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ");
}

// Prepare history for a model prompt: most recent turns only, citations removed,
// assistant answers truncated. Shared by condense() and streamAnswer().
//
// `keepLastCitations` exists for one specific case, and it was found by watching
// the thing fail. On a `reuse` turn — "make that shorter" — the sources handed to
// the model are LITERALLY the previous turn's, so that answer's [n] markers are
// still valid and stripping them is simply wrong.
//
// Worse than wrong, it actively caused a bug: the model was being shown its own
// previous answer with every citation removed and then asked to reproduce it
// more briefly, so it copied what it saw and dropped the markers. Rule 9 in
// answer.ts told it not to and lost to the example directly above. The
// demonstration beats the instruction — which is the general lesson, not a quirk
// of this prompt.
//
// It stays FALSE everywhere else, including for condense(), because a rewriter
// has no source list at all and markers there are pure noise.
export function trimHistory(
  history: HistoryTurn[],
  keepLastCitations = false,
): HistoryTurn[] {
  const recent = history.slice(-HISTORY_TURNS);
  const lastIndex = recent.length - 1;

  return recent.map((turn, i) => {
    if (turn.role === "user") return turn;

    // Only the FINAL message qualifies, and only when it is the assistant's:
    // that is the one whose numbering matches the sources being sent now. An
    // older answer in the same thread was built from a different retrieval and
    // its markers still have to go.
    const keep = keepLastCitations && i === lastIndex;
    const cleaned = (keep ? turn.content : stripCitations(turn.content)).trim();

    return {
      role: turn.role,
      content:
        cleaned.length > ASSISTANT_PREVIEW_CHARS
          ? `${cleaned.slice(0, ASSISTANT_PREVIEW_CHARS)}…`
          : cleaned,
    };
  });
}

type CondenseInput = {
  history: HistoryTurn[];
  question: string;
  signal?: AbortSignal;
};

export async function condense({
  history,
  question,
  signal,
}: CondenseInput): Promise<CondenseResult> {
  // THE FIRST TURN COSTS NOTHING. With no history there is nothing to resolve
  // against — the question is already standalone by definition. Skipping the
  // call here matters more than it looks: the first turn is the most common
  // request this app serves, and paying ~300ms and a model call to rewrite a
  // question into itself would make the headline interaction slower for no gain.
  if (history.length === 0) {
    return { kind: "search", question, rewritten: false };
  }

  const trimmed = trimHistory(history);

  try {
    const completion = await openai.chat.completions.create(
      {
        model: env.CHAT_MODEL,
        // Same reasoning as generation: this is a mechanical transformation, not
        // writing. Creativity here means a query that drifts from what was
        // asked, and it would make the eval harness non-deterministic.
        temperature: 0,
        // A hard ceiling on the runaway case. If the model decides to answer
        // instead of rewrite, this stops it early rather than billing for a full
        // essay we are about to throw away.
        max_tokens: 100,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...trimmed,
          // The follow-up is repeated here, outside the history, with an
          // explicit label. Left as just the last history message the model
          // frequently rewrites the wrong turn — this makes the target
          // unambiguous.
          { role: "user", content: `Rewrite this into a standalone query: ${question}` },
        ],
      },
      { signal },
    );

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";

    if (raw.includes(NO_SEARCH)) return { kind: "reuse" };

    const cleaned = unquote(raw);

    // Every guard below falls back to the RAW QUESTION rather than failing. That
    // is the whole error policy of this file: condensing is a quality
    // improvement, and the behaviour without it is exactly what the app did
    // before this feature existed. Degrading to "search for what the user
    // literally typed" is always safe; erroring out is not.
    if (!cleaned) return { kind: "search", question, rewritten: false };
    if (cleaned.length > MAX_REWRITE_CHARS) {
      return { kind: "search", question, rewritten: false };
    }

    return { kind: "search", question: cleaned, rewritten: cleaned !== question };
  } catch (err) {
    // An abort is the client leaving, not a failure — it must propagate so the
    // caller stops work instead of continuing on to spend money on retrieval and
    // generation for a socket that is already closed.
    if (signal?.aborted) throw err;

    // Anything else (a 429, a timeout, a malformed response) is logged and
    // swallowed. See the fallback policy above.
    console.error("[condense] rewrite failed, falling back to the raw question:", err);
    return { kind: "search", question, rewritten: false };
  }
}

// Models wrap rewrites in quotes remarkably often, and a leading `"` is a real
// token that shifts the embedding. Strips one matching pair, nothing more —
// a question that legitimately contains quotes keeps them.
function unquote(text: string): string {
  const match = /^"(.*)"$/s.exec(text) ?? /^'(.*)'$/s.exec(text);
  return (match ? match[1] : text).trim();
}
