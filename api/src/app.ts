import express from "express";
import cors from "cors";
import { prisma } from "./lib/prisma";
import { authRouter } from "./modules/auth/auth.routes";
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

  app.use(express.json({limit: "1mb"}));
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

  // Error middleware must be registered LAST, after all routes.
  app.use(errorHandler);

  return app;
}
