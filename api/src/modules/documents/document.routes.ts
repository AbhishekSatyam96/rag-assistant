import { Router, type Request } from "express";
import multer from "multer";
import { HttpError } from "../../lib/http-error.js";
import { extractPdf, hasNoText } from "../../lib/pdf.js";
import { MAX_UPLOAD_BYTES } from "../../lib/upload.js";
import { ingestLimiter } from "../../middleware/rate-limit.js";
import {
  CONTENT_MAX,
  TITLE_MAX,
  createDocumentSchema,
  listDocumentsQuerySchema,
  uploadDocumentSchema,
} from "./document.schema.js";
import * as documentService from "./document.service.js";

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

// --- PDF upload --------------------------------------------------------------

// The cap and the sentence describing it both live in lib/upload.ts, so the
// error message cannot drift away from what is enforced. The real fix for large
// files is client-side upload straight to blob storage, bypassing the function
// body entirely — a feature, not a constant, and deferred.

// WHY memoryStorage AND NOT diskStorage
// The file exists only long enough to be turned into text — nothing downstream
// wants the bytes, and we never serve them back. Writing to disk would mean
// temp files to clean up (including on the failure paths), plus a container
// filesystem to reason about at deploy time. Holding it in RAM is justified
// precisely because `fileSize` below caps how much RAM that can be.
//
// THIS LIMIT IS THE ONLY ONE THAT APPLIES. `express.json({ limit: "1mb" })` in
// app.ts is content-type-gated: it inspects the Content-Type header, sees
// `multipart/form-data`, and calls next() without reading a byte. A reader who
// assumes the global JSON limit also guards uploads would be wrong, and the
// consequence of getting this wrong is an unbounded upload, so: multer's
// `limits` is the boundary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    // Belt and braces against a body crafted to make us allocate: one file, and
    // a small ceiling on the non-file fields (we read exactly one, `title`).
    files: 1,
    fields: 4,
  },
});

// A multipart filename is attacker-controlled: it is a string in the request
// body, not something the OS vouched for, and it can legally contain "../",
// NUL bytes and control characters. It is about to become a document title
// rendered in a list, so it gets cleaned first.
//
// To be precise about what this is and isn't: it is NOT XSS defence — React
// escapes text nodes, and nothing here is ever used as a filesystem path. It is
// about not storing a traversal string as a document title, and about control
// characters not making one row of the UI render as garbage.
function titleFromFilename(filename: string): string {
  const cleaned = filename
    .replace(/\.pdf$/i, "")
    // Path separators and C0/C1 control characters, collapsed to a space. The
    // escapes are written out rather than typed literally so this file stays
    // plain ASCII — a raw NUL byte in source is invisible in every editor and
    // survives review.
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // A file called ".pdf", or one whose name was nothing but separators, leaves
  // us with an empty string. Fall back rather than 400 — the upload itself is
  // fine, only the label is missing.
  return cleaned.slice(0, TITLE_MAX) || "Untitled PDF";
}

// POST /documents/upload — multipart, one PDF.
//
// A SEPARATE ROUTE rather than teaching POST /documents to sniff its own
// Content-Type. Two body parsers with two different failure modes, two
// different validation schemas, and two different sets of error codes do not
// belong behind one handler branching on a header — the JSON route stays
// exactly as it was, and neither path can break the other.
//
// `ingestLimiter` is reused deliberately: same budget, because this ends in the
// same embedding calls. The middleware ORDER matters — the limiter runs BEFORE
// multer, so a rate-limited caller is rejected without us first accepting and
// buffering the whole file from them.
documentRouter.post("/upload", ingestLimiter, upload.single("file"), async (req, res) => {
  // `req.file` is undefined when the field is missing or misnamed. Multer does
  // not treat that as an error, so an explicit check is the difference between
  // a clear 400 and a TypeError surfacing as a 500.
  if (!req.file) {
    throw new HttpError(400, "No file uploaded. Attach a PDF as the `file` field.");
  }

  const { title: providedTitle } = uploadDocumentSchema.parse(req.body);

  // Parse first, THEN decide the title, so a corrupt file fails before we do
  // any bookkeeping for it.
  const extracted = await extractPdf(req.file.buffer);

  // 422, not 400: the request was well-formed and the file parsed cleanly —
  // there is simply nothing in it to index. Overwhelmingly this is a scan, so
  // the message names that cause rather than saying "empty", which would send
  // the user looking for the wrong problem.
  if (hasNoText(extracted)) {
    throw new HttpError(
      422,
      "No selectable text found — this looks like a scanned PDF. OCR isn't supported yet.",
    );
  }

  // The join that dedupe depends on. Pages are joined with a blank line for two
  // reasons: it is a paragraph boundary, which is the first thing the text
  // splitter looks for on the non-PDF path; and it must be done IDENTICALLY
  // every time, because `content` is what gets hashed. Change this separator
  // and every previously-ingested PDF stops deduping against its own re-upload.
  //
  // `.trim()` mirrors what zod does to a pasted `content`, so the same text
  // arriving by either route hashes to the same value and collapses into one
  // document.
  const content = extracted.pages.join("\n\n").trim();

  // The same ceiling the paste path enforces, checked here because the text did
  // not arrive in a body zod could validate. A 4 MB PDF can easily exceed it.
  //
  // REJECT RATHER THAN TRUNCATE. Silently keeping the first 200k characters
  // produces a document the user believes is complete; they then ask about
  // something on page 90 and get a confident "that isn't in your documents".
  // A failed upload is recoverable, a silently incomplete corpus is not.
  if (content.length > CONTENT_MAX) {
    throw new HttpError(
      400,
      `This PDF holds ${content.length.toLocaleString()} characters of text, over the ${CONTENT_MAX.toLocaleString()} limit. Try splitting it up.`,
    );
  }

  const result = await documentService.ingestDocument({
    userId: currentUserId(req),
    title: providedTitle ?? titleFromFilename(req.file.originalname),
    content,
    // The one thing that makes this route worth having: page structure survives
    // into chunking, so citations can name a page.
    pages: extracted.pages,
  });

  const document = await documentService.getDocument({
    userId: currentUserId(req),
    id: result.id,
  });

  // Same shape and the same 200-vs-201 rule as the JSON route above, so the
  // client can reuse one response type, one renderer and one polling loop.
  res.status(result.deduped ? 200 : 201).json({ document, deduped: result.deduped });
});

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

// Paginated, cursor-based. The response gained a `nextCursor` field rather than
// changing shape, so a client written against the old `{ documents }` keeps
// working and simply never paginates — which is what made this safe to add
// after the frontend already shipped.
documentRouter.get("/", async (req, res) => {
  // `req.query`, not `req.body`: values arrive as strings (or as an ARRAY, if a
  // key is repeated — `?limit=1&limit=2`), which is why the schema coerces.
  // An array coerces to NaN and is rejected by `.int()`, so a repeated param is
  // a clean 400 rather than a surprise.
  const { limit, cursor } = listDocumentsQuerySchema.parse(req.query);

  const page = await documentService.listDocuments({
    userId: currentUserId(req),
    limit,
    cursor,
  });

  // Spread the service's DocumentPage straight out rather than rebuilding it
  // field by field, so the wire shape is declared in exactly one place.
  res.json(page);
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
