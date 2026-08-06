import { Router, type Request } from "express";
import { HttpError } from "../../lib/http-error.js";
import { streamNdjson } from "../../lib/ndjson-stream.js";
import { askSchema } from "./query.schema.js";
import * as queryService from "./query.service.js";

// Mounted behind requireAuth in app.ts, same as documentRouter — protection at
// the mount point, not per-route.
//
// The NDJSON writing, the deferred headers and the disconnect-abort wiring all
// moved to lib/ndjson-stream.ts when the conversations router needed the same
// behaviour. The long explanations of *why* each of those is shaped the way it
// is live there now; this file is back to being a thin route.
export const queryRouter = Router();

function currentUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthenticated");
  return req.user.id;
}

queryRouter.post("/", async (req, res) => {
  const { question, k } = askSchema.parse(req.body);
  const userId = currentUserId(req);

  await streamNdjson({
    res,
    tag: "queries",
    fallbackMessage: "Failed to generate answer",
    events: (signal) => queryService.answerQuestion({ userId, question, k, signal }),
  });
});
