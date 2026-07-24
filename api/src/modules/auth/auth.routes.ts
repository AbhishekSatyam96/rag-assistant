import { Router } from "express";
import { credentialsSchema } from "./auth.schema";
import * as authService from "./auth.service";

// The route layer is thin on purpose: parse/validate input, call the service,
// shape the response. No business logic lives here.
export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  // .parse() throws a ZodError on bad input → caught by the error middleware.
  const credentials = credentialsSchema.parse(req.body);
  const result = await authService.signup(credentials);
  res.status(201).json(result); // 201 Created
});

authRouter.post("/login", async (req, res) => {
  const credentials = credentialsSchema.parse(req.body);
  const result = await authService.login(credentials);
  res.status(200).json(result);
});
