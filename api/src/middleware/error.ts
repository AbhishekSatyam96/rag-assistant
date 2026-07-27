import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { HttpError } from "../lib/http-error.js";
import { MAX_UPLOAD_LABEL } from "../lib/upload.js";

// body-parser (i.e. express.json()) can reject a request before it ever reaches
// a route: body over the configured limit, malformed JSON, an encoding we can't
// read. Those are plainly the CLIENT's fault, but the errors are neither
// ZodError nor HttpError — so without this branch they fell through to the
// generic 500 below, and someone POSTing a 2mb paste got back "Internal Server
// Error". Wrong status, and it tells them nothing about how to fix it.
//
// The errors originate in `http-errors` (hence `status`); body-parser adds a
// `type` discriminator, which is what we switch on.
type BodyParserError = Error & { type: string; status: number; limit?: number };

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    err instanceof Error &&
    typeof (err as Partial<BodyParserError>).type === "string" &&
    typeof (err as Partial<BodyParserError>).status === "number"
  );
}

function bodyParserMessage(err: BodyParserError): string {
  switch (err.type) {
    case "entity.too.large":
      // `err.limit` is the byte limit body-parser was configured with, read
      // straight off the error — so this message cannot drift from whatever
      // `express.json({ limit })` says in app.ts.
      return err.limit
        ? `Request body too large (limit ${err.limit} bytes)`
        : "Request body too large";
    case "entity.parse.failed":
      return "Malformed JSON in request body";
    case "charset.unsupported":
    case "encoding.unsupported":
      return "Unsupported request body encoding";
    default:
      return "Invalid request body";
  }
}

// Multer rejects a bad upload by throwing a `MulterError`, and it needs its own
// branch for a subtle reason: MulterError carries a `code` (a string like
// "LIMIT_FILE_SIZE") but NOT the `type` + numeric `status` pair that
// isBodyParserError sniffs for. So without this it falls straight through to
// the generic 500 below, and a user uploading a 12 MB PDF is told "Internal
// Server Error" for something that is entirely their side and entirely fixable.
//
// The status split matters too: an oversized file is 413 (the semantically
// correct "payload too large"), while a malformed multipart body is 400.
function multerMessage(err: MulterError): { status: number; message: string } {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      // Multer's own message is "File too large" with no number in it, which
      // leaves the user guessing at the limit. The number is imported rather
      // than written out: this message used to hardcode "10 MB" and kept saying
      // so after the cap dropped to 4 MB, telling users a limit that was not the
      // limit. See lib/upload.ts.
      return {
        status: 413,
        message: `That file is too large. The limit is ${MAX_UPLOAD_LABEL}.`,
      };
    case "LIMIT_FILE_COUNT":
    case "LIMIT_UNEXPECTED_FILE":
      // Either more files than configured, or a file on a field name we don't
      // accept. Both mean the client built the form wrong.
      return { status: 400, message: "Upload exactly one file, in the `file` field." };
    case "LIMIT_FIELD_COUNT":
    case "LIMIT_FIELD_KEY":
    case "LIMIT_FIELD_VALUE":
    case "LIMIT_PART_COUNT":
      return { status: 400, message: "Too many form fields in the upload." };
    default:
      return { status: 400, message: "Invalid file upload." };
  }
}

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

  if (err instanceof MulterError) {
    const { status, message } = multerMessage(err);
    res.status(status).json({ error: message });
    return;
  }

  // Only trust a 4xx from body-parser. A 5xx coming out of it is a real server
  // fault, not a bad request, so it belongs in the logged branch below.
  if (isBodyParserError(err) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: bodyParserMessage(err) });
    return;
  }

  // Anything we didn't anticipate: log it server-side, but never leak internals.
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
};
