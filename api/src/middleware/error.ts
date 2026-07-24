import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/http-error";

// The single place that turns thrown errors into HTTP responses.
// Express recognizes this as error-handling middleware because it takes 4 args.
// In Express 5, errors thrown from async handlers are forwarded here
// automatically — no more try/catch + next(err) in every route.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "ValidationError", details: err.issues });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // Anything we didn't anticipate: log it server-side, but never leak internals.
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
};
