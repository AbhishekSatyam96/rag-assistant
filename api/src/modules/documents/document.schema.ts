import { z } from "zod";

// One schema, used two ways:
//   1) at runtime to validate/parse the POST /documents body
//   2) at compile time as the `CreateDocumentInput` type (single source of truth)
//
// Note what is deliberately NOT here: `userId`. Ownership comes from the
// verified token (`req.user.id`), never from the request body — otherwise any
// logged-in user could ingest documents into someone else's library by editing
// one JSON field.
//
// Unknown keys are stripped rather than rejected (zod's default for objects),
// so a client that POSTs `status: "READY"` hoping to skip the ingestion
// pipeline just has that field silently dropped.
// The ceiling on a document's text, exported because it is enforced in two
// places that must agree: this schema (the paste path) and the upload route,
// where the text comes out of a PDF and so cannot be validated by a body
// schema at all. One constant, so the two can't drift.
export const CONTENT_MAX = 200_000;

export const TITLE_MAX = 200;

// `.trim()` must come BEFORE `.min(1)`: these run left to right, so
// `.min(1).trim()` would measure the untrimmed string ("   " is 3 chars, so it
// passes) and only then trim it to "" — storing an empty title, no error.
const titleSchema = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters`);

export const createDocumentSchema = z.object({
  title: titleSchema,

  // The 200k ceiling sits deliberately below the 1mb `express.json()` limit in
  // app.ts: an oversized paste fails here, with a field-level message, instead
  // of reaching body-parser and surfacing as a bare 413.
  //
  // Trimming `content` also normalizes what gets hashed for dedupe (see
  // hashContent in document.service.ts), so the same text pasted with stray
  // leading/trailing whitespace correctly counts as the same document.
  content: z
    .string()
    .trim()
    .min(1, "Content is required")
    .max(CONTENT_MAX, "Content must be at most 200,000 characters"),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

// The multipart sibling. Note what ISN'T here: the file. Multer has already
// consumed it into `req.file` by the time this runs, and a Buffer is not
// something zod should be pretending to validate — the file's checks (magic
// bytes, page count, extractable text) live in lib/pdf.ts, next to the parser
// that can actually make sense of them.
//
// So this validates the one ordinary text field that rides along, and `title`
// is OPTIONAL here where it is required for a paste: a file has a name, and
// making someone retype "Q3 handbook" when they just picked q3-handbook.pdf is
// friction with no purpose. The route fills the gap from the filename.
export const uploadDocumentSchema = z.object({
  // A title that IS supplied still has to clear the same min/max as the paste
  // path — hence `titleSchema` rather than a looser inline rule.
  //
  // The `preprocess` step handles a quirk of multipart specifically: an empty
  // form field arrives as `""`, not as an absent key. Without this, leaving the
  // title box blank sends "", which fails `.min(1)` and 400s a request that is
  // perfectly reasonable — the user meant "use the filename". Collapsing "" to
  // undefined BEFORE validation is what makes `.optional()` mean what it looks
  // like it means here.
  title: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    titleSchema.optional(),
  ),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

// --- GET /documents pagination ----------------------------------------------

// What a client gets when it asks for nothing, and the ceiling on what it may
// ask for. THE CEILING IS THE LOAD-BEARING ONE: without it `?limit=999999` is a
// free full-table read of a user's entire library, in a `select` that includes
// `error` strings — the same class of problem CONTENT_MAX solves on the write
// path, and the reason a default alone is not enough.
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export const listDocumentsQuerySchema = z.object({
  // `z.coerce`, unlike every other field in this file, because query-string
  // values are ALWAYS strings: `?limit=20` arrives as "20" and a plain
  // z.number() rejects it. Two coercion traps worth naming, because neither is
  // caught by the type:
  //   Number("")    === 0    -> `?limit=` would silently mean "zero documents"
  //   Number("abc") === NaN  -> NaN IS a number, so typeof passes
  // `.int()` and the bounds below are what actually reject both.
  limit: z.coerce
    .number()
    .int("limit must be a whole number")
    .min(1, "limit must be at least 1")
    .max(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),

  // The id of the last document on the previous page. Opaque to the client, and
  // deliberately unvalidated beyond "non-empty" — for exactly the reason the
  // `:id` param is unvalidated in document.routes.ts: a malformed cursor, a
  // deleted one, and another user's all resolve to the same answer, so a format
  // check would be the only branch that behaved differently, for no benefit.
  //
  // The preprocess mirrors uploadDocumentSchema's: `?cursor=` arrives as "",
  // which MEANS "no cursor" but would fail `.min(1)` and 400 a request that is
  // perfectly reasonable.
  cursor: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
