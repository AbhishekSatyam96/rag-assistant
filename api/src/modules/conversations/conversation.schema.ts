import { z } from "zod";

// Validation for the chat surface. Deliberately a near-copy of query.schema.ts
// rather than an import of it: the two endpoints are allowed to diverge (chat
// may grow a `regenerate` flag, /queries never will), and a shared schema is a
// coupling that would make one endpoint's change a risk to the other. The rules
// that are load-bearing are re-stated below rather than cross-referenced.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

// Same ceiling as a document title, and it is not decorative: `title` is derived
// from the first question, and a question may be up to 1000 characters.
export const TITLE_MAX = 80;

// `.trim()` BEFORE `.min(1)`, not after. Reversed, zod measures the raw string —
// "   " is three characters and passes min(1) — then trims to "", so an empty
// question reaches the embedder and gets billed for embedding nothing.
const question = z
  .string()
  .trim()
  .min(1, "Question is required")
  .max(1000, "Question must be at most 1000 characters");

// How many chunks to retrieve. Capped because it feeds straight into the model's
// context window, and `.int()` because k reaches SQL as a LIMIT — `LIMIT 2.5` is
// a Postgres error, i.e. a 500 for what is really a bad request.
const k = z.number().int().min(1).max(10).default(5);

// POST /conversations — start a new thread with its first question.
//
// No `title` field. The title is derived server-side from the question, so a
// client cannot set one; that keeps the list rendering predictable and removes a
// free-text field that exists only to be abused.
export const startConversationSchema = z.object({ question, k });

// POST /conversations/:id/messages — continue an existing thread.
//
// No `conversationId` in the body: it is the path parameter, and accepting it in
// both places creates a case where the two disagree. No `history` either, for a
// reason worth stating explicitly — history comes from the database, never from
// the client. A client-supplied transcript would let a caller fabricate an
// ASSISTANT turn, which lands in the slot of the prompt the model trusts most.
// Ownership and conversation state both come from the server, exactly like
// `userId` does.
export const continueConversationSchema = z.object({ question, k });

export const listConversationsQuerySchema = z.object({
  // `z.coerce`, unlike the body schemas, because query-string values are ALWAYS
  // strings: `?limit=20` arrives as "20" and a plain z.number() rejects it. Two
  // traps the type system does not catch — Number("") === 0 and Number("abc")
  // === NaN, which is itself a number — are both closed by `.int()` and the
  // bounds rather than by the coercion.
  limit: z.coerce
    .number()
    .int("limit must be a whole number")
    .min(1, "limit must be at least 1")
    .max(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),

  // Opaque to the client and deliberately unvalidated beyond "non-empty", for
  // the same reason the `:id` params are: a malformed cursor, a deleted one and
  // another user's all resolve to the same first page, so a format check would
  // be the only branch that behaved differently.
  //
  // The preprocess handles `?cursor=`, which arrives as "" and MEANS "no cursor"
  // but would fail `.min(1)` and 400 a perfectly reasonable request.
  cursor: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
});

// Derive a thread title from its opening question. Not a model call: a generated
// title costs a request per conversation to produce something marginally nicer
// than the words the user just typed, and it would be one more thing that can
// fail on the critical path of starting a chat.
//
// Cut on a word boundary when there is one reasonably close to the limit,
// because "What does the handbook say about parental le…" reads as broken while
// "What does the handbook say about parental…" reads as truncated.
export function titleFromQuestion(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;

  const cut = collapsed.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}
