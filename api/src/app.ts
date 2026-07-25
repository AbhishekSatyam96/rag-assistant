import express from "express";
import cors from "cors";
import { prisma } from "./lib/prisma";
import { authRouter } from "./modules/auth/auth.routes";
import { documentRouter } from "./modules/documents/document.routes";
import { queryRouter } from "./modules/queries/query.routes";
import { requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/error";
import { limitConcurrent } from "./middleware/concurrency";
import {
  queryBurstLimiter,
  queryDailyLimiter,
  globalQueryLimiter,
} from "./middleware/rate-limit";

// Building the app in a function (instead of at module top-level) keeps the
// wiring separate from "start listening". Later this lets a test file import
// createApp() and hit routes in-memory (supertest) without opening a port.
export function createApp() {
  const app = express();

  // Every rate limit that keys on IP depends on `req.ip` being the CALLER's
  // address. Express derives it from the socket unless told otherwise, and in
  // production the socket belongs to Cloud Run's front end, not the user — so
  // without this, every request on Earth shares one bucket and the first
  // stranger to trip a limit locks out everybody, including me.
  //
  // The value is a HOP COUNT, not `true`. `req.ip` is then read from
  // X-Forwarded-For, counting exactly one proxy back from the right. `true`
  // says "trust the whole chain", and since anyone can send an X-Forwarded-For
  // header, that hands an attacker a fresh, unlimited bucket per request — the
  // rate limiter would still be there, still reporting, and enforcing nothing.
  //
  // 1 is correct for a single proxy in front of the app (Cloud Run, and locally
  // where there is no proxy at all so the header is absent and the socket
  // address is used). Adding a CDN or a load balancer in front of that means
  // incrementing this. express-rate-limit validates the setting at startup and
  // will log if what it sees on the wire disagrees with what is configured.
  app.set("trust proxy", 1);

  // CORS: the browser blocks cross-origin requests (web/ on :3000 -> api on
  // :4000) unless the server opts in. Allow the Next.js dev origin. At deploy
  // time this becomes an env var (e.g. the Vercel URL); `credentials: true`
  // only matters if we later switch to httpOnly cookies for the token.
  app.use(
    cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  // 1mb of JSON is ~250k characters of pasted text — comfortably more than the
  // 200k `content` ceiling in document.schema.ts, so an oversized paste is
  // rejected by zod with a field-level message and only a genuinely absurd body
  // trips this limit (and gets a 413 from the error middleware).
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    const users = await prisma.user.count();
    res.json({ status: "ok", users });
  });

  // Rate limits live at the mount point when they apply to an entire router
  // (see /queries below), and on the individual route when they don't. Signup
  // and login need different windows, and only POST /documents costs anything
  // to serve — so those three are attached inside their routers. The numbers
  // themselves are all in middleware/rate-limit.ts.
  app.use("/auth", authRouter); // POST /auth/signup, POST /auth/login

  // A protected route to prove the middleware end to end: returns the caller's
  // identity, decoded from their token.
  app.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // requireAuth is applied at the MOUNT POINT, not inside document.routes.ts, so
  // it covers every current and future route in that router. Forgetting the
  // middleware on a newly added route is a classic way to ship an unauthenticated
  // endpoint; this makes that impossible.
  //   POST /documents, GET /documents, GET /documents/:id
  app.use("/documents", requireAuth, documentRouter);

  // POST /queries — ask a question, get a streamed grounded answer + citations.
  //
  // A POST to a plural resource, not `GET /answer?q=...`, for three reasons:
  // the request has a body (question + k) rather than a lone param; questions
  // are not URL-length-safe; and answers must never be cached by an
  // intermediary keyed on the URL, since the same question yields different
  // answers per user. The response streams, but the request is still a normal
  // JSON POST — see the NDJSON note in query.routes.ts.
  //
  // The four guards in front of it are the whole cost-control story for the
  // most expensive route in the app, and their ORDER is load-bearing:
  //
  //   requireAuth       must be first — everything after it keys on req.user.id,
  //                     which does not exist before it runs.
  //   burst, then daily a burst rejection must not spend the daily budget.
  //   global            after the per-user limits, so one abusive account is
  //                     stopped by its own budget before it can eat the shared
  //                     one that everybody else is drawing from.
  //   limitConcurrent   last, because it is the only one holding state for the
  //                     LIFETIME of the request rather than the instant of
  //                     arrival: it must not increment for a request that one
  //                     of the limiters above is about to reject.
  //
  // All of them sit in front of the router, which is what makes a 429 possible
  // at all here. This route streams, and the moment queryRouter calls
  // flushHeaders() the status code is spent — a limit discovered after that
  // point could only be reported as an in-band error event on a 200 response.
  // See the long comment in query.routes.ts.
  app.use(
    "/queries",
    requireAuth,
    queryBurstLimiter,
    queryDailyLimiter,
    globalQueryLimiter,
    // 2, not 1: a user who asks a question, changes their mind, and asks
    // another should not be blocked by their own abandoned stream in the
    // moment before the socket closes. Beyond that, a human has no reason to
    // hold three generations open at once — but a script does.
    limitConcurrent(2, "You already have answers in progress. Wait for them to finish."),
    queryRouter,
  );

  // Error middleware must be registered LAST, after all routes.
  app.use(errorHandler);

  return app;
}
