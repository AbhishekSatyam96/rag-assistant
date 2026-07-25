import { Router, type Request } from "express";
import { HttpError } from "../../lib/http-error";
import { ingestLimiter } from "../../middleware/rate-limit";
import { createDocumentSchema } from "./document.schema";
import * as documentService from "./document.service";

// Thin route layer, same shape as auth.routes.ts: validate input, call the
// service, choose a status code. No business logic here.
//
// Every route is protected — the router is mounted behind `requireAuth` in
// app.ts rather than repeating the middleware per route, so a route added later
// cannot accidentally ship unauthenticated.
export const documentRouter = Router();

// `req.user` is optional in the type system, and it has to be: unauthenticated
// requests are real. Narrowing it here — once — beats scattering `!` assertions
// across three handlers, and it converts a genuine mistake into a clean 401:
// if this router were ever mounted WITHOUT requireAuth, `req.user!.id` would
// throw a TypeError and surface as a confusing 500, whereas this says exactly
// what went wrong.
function currentUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthenticated");
  return req.user.id;
}

// The limiter goes on POST alone, not at the mount point in app.ts, because
// ingestion is the only route in this router that costs anything: it embeds up
// to ~200 chunks. The two GETs are reads of rows this user already paid for,
// and putting them in the same bucket would mean a dashboard that polls a
// PROCESSING document could exhaust the budget for uploading one.
documentRouter.post("/", ingestLimiter, async (req, res) => {
  // .parse() throws a ZodError on bad input → the error middleware turns it
  // into a 400 with per-field details.
  const input = createDocumentSchema.parse(req.body);

  // `userId` comes from the verified token, never from the body — see the note
  // in document.schema.ts about why it is absent from the schema.
  const result = await documentService.ingestDocument({
    userId: currentUserId(req),
    ...input,
  });

  // Re-read the row so this responds with the SAME shape as GET /documents/:id.
  // That costs one cheap SELECT and buys a real simplification on the client:
  // one Document type, one renderer, and a polling loop that doesn't have to
  // special-case the response that started it.
  const document = await documentService.getDocument({
    userId: currentUserId(req),
    id: result.id,
  });

  // 201 Created would be a lie when we deduped and created nothing — the
  // service recognised this exact content and handed back the existing row. The
  // `deduped` flag rides along so the UI can say "already in your library"
  // instead of a misleading "uploaded".
  res.status(result.deduped ? 200 : 201).json({ document, deduped: result.deduped });
});

documentRouter.get("/", async (req, res) => {
  const documents = await documentService.listDocuments({
    userId: currentUserId(req),
  });
  res.json({ documents });
});

// No zod validation on `:id`, deliberately: an id that is malformed, an id that
// doesn't exist, and an id belonging to another user all answer with an
// identical 404 (see getDocument). Adding a 400 for "wrong format" would be the
// only response that behaves differently, for no benefit.
//
// This relies on `Document.id` being a text column. If it is ever changed to
// @db.Uuid, Postgres will reject a non-uuid at the cast and this becomes a 500 —
// at which point validating the param here is the fix.
documentRouter.get("/:id", async (req, res) => {
  const document = await documentService.getDocument({
    userId: currentUserId(req),
    id: req.params.id,
  });
  res.json({ document });
});
