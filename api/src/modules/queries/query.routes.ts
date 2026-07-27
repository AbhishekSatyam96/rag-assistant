import { Router, type Request, type Response } from "express";
import { HttpError } from "../../lib/http-error.js";
import { askSchema } from "./query.schema.js";
import * as queryService from "./query.service.js";
import type { QueryEvent } from "./query.service.js";

// Mounted behind requireAuth in app.ts, same as documentRouter — protection at
// the mount point, not per-route.
export const queryRouter = Router();

function currentUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthenticated");
  return req.user.id;
}

// NDJSON — one JSON object per line — rather than Server-Sent Events.
//
// This is a constraint, not a preference. SSE's browser client is EventSource,
// and EventSource cannot set request headers. Our auth is a Bearer token in an
// Authorization header, so SSE would force the token into a query string (where
// it lands in server logs, browser history, and Referer headers) or force an
// early move to cookies. `fetch` + ReadableStream reads a stream just as well
// and sends headers normally.
//
// NDJSON over a raw text stream because every event needs structure — sources,
// tokens and errors are different shapes — and `JSON.parse` per line is the
// entire client-side parser. The one rule it imposes: no literal newline inside
// a serialised event, which `JSON.stringify` already guarantees by escaping
// them as \n.
function writeEvent(res: Response, event: QueryEvent) {
  res.write(`${JSON.stringify(event)}\n`);
}

queryRouter.post("/", async (req, res) => {
  const { question, k } = askSchema.parse(req.body);

  // If the client goes away — closed tab, navigated off, hit stop — abort the
  // in-flight OpenAI request instead of streaming tokens into a dead socket.
  // Without this we pay, in full, for output nobody will ever see, and the
  // request occupies a connection until the model finishes talking to itself.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const events = queryService.answerQuestion({
    userId: currentUserId(req),
    question,
    k,
    signal: abort.signal,
  });

  // THE CENTRAL CONSTRAINT OF ANY STREAMING ENDPOINT: a response has exactly one
  // status code, and it is committed the instant the first byte leaves. Before
  // that, an error can be a clean 500/429/401. After it, the client has already
  // been told "200 OK" and is parsing a body — there is no way to take that
  // back, and a thrown error would simply truncate the stream, which looks
  // identical to a network drop.
  //
  // So the error path forks on exactly one question: have we sent headers yet?
  //   - Not yet  → rethrow, and the normal error middleware produces a real
  //                status code, exactly like any other route.
  //   - Already  → the failure has to travel in-band, as an `error` event.
  //
  // Headers are therefore deferred until the first event actually arrives.
  // Generators being lazy is what makes that possible: `answerQuestion` has not
  // executed a single line yet, so retrieval failures still land in the first
  // branch and get a proper status.
  let headersSent = false;

  try {
    for await (const event of events) {
      if (!headersSent) {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        // A cached partial answer would be worse than no answer.
        res.setHeader("Cache-Control", "no-store");
        // Tells nginx-style reverse proxies not to buffer. Without it a proxy
        // may hold the whole response and deliver it in one lump — the endpoint
        // still "works" while the streaming UX silently disappears in
        // production and only in production.
        res.setHeader("X-Accel-Buffering", "no");
        // Push the headers out now rather than waiting for the first flush, so
        // the browser can begin reading immediately.
        res.flushHeaders();
        headersSent = true;
      }

      writeEvent(res, event);
    }

    res.end();
  } catch (err) {
    // An abort is not a failure — it is the client leaving, which we asked for
    // above. The socket is already gone, so writing to it would only produce a
    // spurious log line.
    if (abort.signal.aborted) return;

    if (!headersSent) throw err;

    // Mid-stream. The status code is spent; report in-band and close cleanly so
    // the client can distinguish "the server told me it failed" from "the
    // connection died", and show a real message instead of a half-finished
    // answer that looks complete.
    console.error("Stream failed after headers were sent:", err);
    writeEvent(res, {
      type: "error",
      message: err instanceof HttpError ? err.message : "Failed to generate answer",
    });
    res.end();
  }
});
