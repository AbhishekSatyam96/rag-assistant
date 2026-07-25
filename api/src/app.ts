import express from "express";
import cors from "cors";
import { prisma } from "./lib/prisma";
import { authRouter } from "./modules/auth/auth.routes";
import { documentRouter } from "./modules/documents/document.routes";
import { queryRouter } from "./modules/queries/query.routes";
import { requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/error";

// Building the app in a function (instead of at module top-level) keeps the
// wiring separate from "start listening". Later this lets a test file import
// createApp() and hit routes in-memory (supertest) without opening a port.
export function createApp() {
  const app = express();

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
  app.use("/queries", requireAuth, queryRouter);

  // Error middleware must be registered LAST, after all routes.
  app.use(errorHandler);

  return app;
}
