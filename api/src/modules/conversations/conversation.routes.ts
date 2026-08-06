import { Router, type Request } from "express";
import { HttpError } from "../../lib/http-error.js";
import { streamNdjson } from "../../lib/ndjson-stream.js";
import { answerConcurrency } from "../../middleware/concurrency.js";
import {
  queryBurstLimiter,
  queryDailyLimiter,
  globalQueryLimiter,
} from "../../middleware/rate-limit.js";
import {
  continueConversationSchema,
  listConversationsQuerySchema,
  startConversationSchema,
} from "./conversation.schema.js";
import * as conversationService from "./conversation.service.js";

// Chat: the multi-turn surface. Mounted behind requireAuth in app.ts.
//
// WHY THE RATE LIMITERS ARE HERE AND NOT AT THE MOUNT POINT, which is where
// /queries puts them. This router mixes expensive writes with cheap reads. Every
// page load lists conversations and opening a thread reads its messages, and
// putting those behind a limiter budgeted for ANSWERS means a user who spent
// today's questions can no longer read the history they already paid for. So the
// two streaming POSTs carry the guards and the GETs do not.
//
// The order of the four is load-bearing, same as in app.ts:
//   burst, then daily → a burst rejection must not spend the daily budget.
//   global            → after the per-user limits, so one abusive account is
//                       stopped by its own budget before eating the shared one.
//   answerConcurrency → last, because it is the only one holding state for the
//                       LIFETIME of the request rather than the instant of
//                       arrival: it must not increment for a request one of the
//                       limiters above is about to reject.
const answerGuards = [
  queryBurstLimiter,
  queryDailyLimiter,
  globalQueryLimiter,
  answerConcurrency,
];

export const conversationRouter = Router();

function currentUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthenticated");
  return req.user.id;
}

// POST /conversations — start a new thread and stream its first answer.
//
// Creating the resource and answering the first question in ONE request, rather
// than POST-then-POST. The alternative costs a round trip before the user sees
// anything, and leaves empty conversations behind whenever the second call never
// arrives. A thread with no question in it is not a thing worth representing.
//
// It answers 200, not 201, because the status code is chosen before the work
// happens — see the header-deferral note in lib/ndjson-stream.ts. The
// `conversation` event carries the new id instead, which the client needs
// anyway to update the URL.
conversationRouter.post("/", ...answerGuards, async (req, res) => {
  const { question, k } = startConversationSchema.parse(req.body);
  const userId = currentUserId(req);

  await streamNdjson({
    res,
    tag: "conversations",
    fallbackMessage: "Failed to generate answer",
    events: (signal) =>
      conversationService.startConversation({ userId, question, k, signal }),
  });
});

// POST /conversations/:id/messages — continue an existing thread.
//
// A sub-resource rather than a `conversationId` field on the route above,
// because "which thread" is identity, not payload — and a body that can disagree
// with the path is a bug waiting to be written. A 404 for a thread that is not
// yours is possible here precisely because the service resolves ownership before
// the first yield, while a real status code is still available.
// The explicit `<{ id: string }>` is not decoration. Express 5 infers param
// types from the route string, and for a param followed by a further path
// segment it widens to `string | string[]` — a shape that would then be passed
// into a Prisma `where` clause. Naming the type here keeps that honest instead
// of reaching for a cast at the call site.
conversationRouter.post<{ id: string }>("/:id/messages", ...answerGuards, async (req, res) => {
  const { question, k } = continueConversationSchema.parse(req.body);
  const userId = currentUserId(req);
  const conversationId = req.params.id;

  await streamNdjson({
    res,
    tag: "conversations",
    fallbackMessage: "Failed to generate answer",
    events: (signal) =>
      conversationService.continueConversation({
        userId,
        conversationId,
        question,
        k,
        signal,
      }),
  });
});

// Cursor-paginated, mirroring GET /documents so the client can reuse the same
// "fetch until nextCursor is null" loop. No total count, deliberately: a count
// is a second query against a table that changes under you, and a cursor API has
// no "page 3 of 7" control to spend it on.
conversationRouter.get("/", async (req, res) => {
  const { limit, cursor } = listConversationsQuerySchema.parse(req.query);

  const page = await conversationService.listConversations({
    userId: currentUserId(req),
    limit,
    cursor,
  });

  res.json(page);
});

// No zod validation on `:id`, deliberately: a malformed id, a nonexistent one,
// and another user's all answer with an identical 404, so a 400 for "wrong
// format" would be the only response that behaved differently — and it would
// tell an attacker which ids are worth trying.
conversationRouter.get("/:id", async (req, res) => {
  const conversation = await conversationService.getConversation({
    userId: currentUserId(req),
    id: req.params.id,
  });

  res.json({ conversation });
});

// 204 No Content: the resource is gone, and there is nothing meaningful to say
// about it afterwards. Returning the deleted object would invite a client to
// render something the server just destroyed.
conversationRouter.delete("/:id", async (req, res) => {
  await conversationService.deleteConversation({
    userId: currentUserId(req),
    id: req.params.id,
  });

  res.status(204).end();
});
