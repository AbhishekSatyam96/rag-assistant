import { Router } from "express";
import { credentialsSchema, signupSchema } from "./auth.schema.js";
import { signupLimiter, loginLimiter } from "../../middleware/rate-limit.js";
import * as authService from "./auth.service.js";

// The route layer is thin on purpose: parse/validate input, call the service,
// shape the response. No business logic lives here.
export const authRouter = Router();

// Per-route rather than at the mount point in app.ts, because signup and login
// are defending against different things — account farming vs credential
// stuffing — and so want different windows and different treatment of a
// successful request.
//
// The limiter runs BEFORE the handler, which is the point: it must reject
// without touching the database or, in login's case, without running argon2.
// A limiter placed after the expensive work still bills you for the work.
authRouter.post("/signup", signupLimiter, async (req, res) => {
  // .parse() throws a ZodError on bad input → caught by the error middleware.
  const credentials = signupSchema.parse(req.body);
  const result = await authService.signup(credentials);
  res.status(201).json(result); // 201 Created
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const credentials = credentialsSchema.parse(req.body);
  const result = await authService.login(credentials);
  res.status(200).json(result);
});
