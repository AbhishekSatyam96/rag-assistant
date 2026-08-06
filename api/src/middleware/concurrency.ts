import type { RequestHandler } from "express";
import { HttpError } from "../lib/http-error.js";

// Caps how many requests one user may have IN FLIGHT at the same instant.
//
// This exists because a rate limiter cannot express it. `10 requests/minute`
// counts arrivals over a window; ten requests that arrive in the same
// millisecond all pass, and we are then paying for ten concurrent completions
// from one account. On a streaming route that is the difference that matters:
// a stream is not a request that finishes in 20ms, it is a request that holds
// an expensive resource open for many seconds.
//
// It also protects something rate limits don't: an Express process has a finite
// number of sockets and a finite event loop, and long-lived responses occupy
// both for their whole lifetime.
//
// Deliberately in-memory and per-process, exactly like the rate limiter's store
// — and the accuracy argument is stronger here, because the thing being counted
// (an open socket) is itself owned by this process. A shared counter in Redis
// would actually be WORSE: it would need a lease with a timeout to survive a
// process dying mid-stream, whereas a Map in the process that holds the socket
// cannot outlive it.
export function limitConcurrent(max: number, message: string): RequestHandler {
  // Closed over per call, so each mount gets its own independent counter rather
  // than sharing one global tally across unrelated routes.
  const inFlight = new Map<string, number>();

  return (req, res, next) => {
    // Mounted behind requireAuth. Same narrowing as the route handlers: a clean
    // 401 beats a TypeError surfacing as a confusing 500 if that ever changes.
    if (!req.user) throw new HttpError(401, "Unauthenticated");
    const key = req.user.id;

    const current = inFlight.get(key) ?? 0;
    if (current >= max) throw new HttpError(429, message);

    inFlight.set(key, current + 1);

    // THE BUG THIS SHAPE PREVENTS: a counter that is incremented on the way in
    // and decremented on a path that doesn't always run leaks. Leak enough and
    // the user is permanently locked out of their own account, with no error to
    // point at and nothing that recovers short of a restart.
    //
    // So the release runs on `close`, which Node emits for BOTH outcomes — the
    // response finishing normally and the client vanishing mid-stream. Listening
    // to `finish` as well would be the obvious "belt and braces" addition and is
    // precisely wrong: `finish` then `close` both fire on a successful response,
    // double-decrementing, and the count drifts negative until the cap silently
    // stops applying. The `released` flag makes the release idempotent so
    // neither mistake can do damage.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;

      const next = (inFlight.get(key) ?? 1) - 1;
      // Delete at zero rather than storing 0 forever: without this the Map is an
      // unbounded, ever-growing leak keyed by every user who ever made a
      // request — invisible in dev, a slow OOM in production.
      if (next <= 0) inFlight.delete(key);
      else inFlight.set(key, next);
    };

    res.on("close", release);

    next();
  };
}

// THE SHARED BUDGET for every route that generates an answer — /queries and both
// streaming chat endpoints.
//
// A single instance rather than a limitConcurrent(...) call at each mount point,
// and the distinction is not cosmetic: `inFlight` is closed over per call, so
// three separate instances would let one user hold 2 + 2 + 2 = six concurrent
// generations while every individual limit still read as "2". The thing being
// protected — OpenAI spend, and this process's sockets — is shared, so the
// counter has to be shared too.
//
// 2, not 1: a user who asks a question, changes their mind, and asks another
// should not be blocked by their own abandoned stream in the moment before the
// socket closes. Beyond that a human has no reason to hold three generations
// open at once — but a script does.
export const answerConcurrency = limitConcurrent(
  2,
  "You already have answers in progress. Wait for them to finish.",
);
