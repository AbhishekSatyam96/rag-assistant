import type { Response } from "express";
import { HttpError } from "./http-error.js";

// Writing a stream of typed events to an HTTP response as NDJSON.
//
// The one file in lib/ that DOES know about HTTP, and named so that is obvious.
// Everything else here is transport-free on purpose; this is the transport.
//
// Extracted from queries/query.routes.ts when the conversations router needed
// the identical behaviour on two more endpoints. Copying it was the alternative
// and would have been a mistake: the `headersSent` fork below is the subtlest
// logic in the codebase, and three copies means the next correction lands in
// one of them.
//
// NDJSON — one JSON object per line — rather than Server-Sent Events. That is a
// constraint, not a preference: SSE's browser client is EventSource, EventSource
// cannot set request headers, and auth here is a Bearer token. SSE would force
// the token into a query string, where it lands in access logs, browser history
// and Referer headers. `fetch` + ReadableStream reads a stream just as well and
// sends headers normally.
//
// The one rule NDJSON imposes: no literal newline inside a serialised event,
// which JSON.stringify already guarantees by escaping them as \n.

type StreamOptions<T> = {
  res: Response;
  // Takes the abort signal rather than closing over one, so the generator is
  // constructed *after* the disconnect listener is wired up and cannot miss an
  // abort that fires immediately.
  events: (signal: AbortSignal) => AsyncGenerator<T>;
  // Prefixes the disconnect log line, so an abandoned /queries stream is
  // distinguishable from an abandoned chat stream in the logs.
  tag: string;
  // What an in-band error says when the underlying failure is not an HttpError
  // and therefore has no message safe to show a user.
  fallbackMessage: string;
};

export async function streamNdjson<T>({
  res,
  events,
  tag,
  fallbackMessage,
}: StreamOptions<T>): Promise<void> {
  // If the client goes away — closed tab, navigated off, hit Stop — abort the
  // in-flight OpenAI request instead of streaming tokens into a dead socket.
  // Without this we pay, in full, for output nobody will ever see, and the
  // request occupies a connection until the model finishes talking to itself.
  //
  // On Vercel this only works because vercel.json sets supportsCancellation:
  // request cancellation is OPT-IN there, and without it the platform never
  // signals a disconnect, so this listener never fires and the abort is
  // decorative — the expensive failure mode, because it looks correct in the
  // source and costs money in production.
  //
  // The log line is the only way to tell those two states apart from outside: a
  // completed stream logs nothing, an abandoned one logs here. It doubles as a
  // cost signal, since abandonment rate is what this guard protects against.
  const abort = new AbortController();
  res.on("close", () => {
    if (res.writableEnded) return; // normal completion, not a disconnect
    console.log(`[${tag}] client disconnected mid-stream, aborting generation`);
    abort.abort();
  });

  const iterator = events(abort.signal);

  // THE CENTRAL CONSTRAINT OF ANY STREAMING ENDPOINT: a response has exactly one
  // status code, and it is committed the instant the first byte leaves. Before
  // that, an error can be a clean 500/429/401/404. After it, the client has
  // already been told "200 OK" and is parsing a body — there is no way to take
  // that back, and a thrown error would simply truncate the stream, which looks
  // identical to a network drop.
  //
  // So the error path forks on exactly one question: have we sent headers yet?
  //   - Not yet  → rethrow, and the normal error middleware produces a real
  //                status code, exactly like any other route.
  //   - Already  → the failure has to travel in-band, as an `error` event.
  //
  // Headers are therefore deferred until the first event actually arrives.
  // Generators being lazy is what makes that possible: the service has not
  // executed a single line yet when this loop begins, so a failure in its
  // opening statements still lands in the first branch and gets a proper status.
  let headersSent = false;

  try {
    for await (const event of iterator) {
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

      res.write(`${JSON.stringify(event)}\n`);
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
    console.error(`[${tag}] stream failed after headers were sent:`, err);
    res.write(
      `${JSON.stringify({
        type: "error",
        // Only an HttpError carries a message that was written to be read by a
        // user. Anything else could be a driver error or a stack trace, and
        // leaking those to the client is how internals end up in a screenshot.
        message: err instanceof HttpError ? err.message : fallbackMessage,
      })}\n`,
    );
    res.end();
  }
}
