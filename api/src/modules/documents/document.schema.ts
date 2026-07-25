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
export const createDocumentSchema = z.object({
  // `.trim()` must come BEFORE `.min(1)`: these run left to right, so
  // `.min(1).trim()` would measure the untrimmed string ("   " is 3 chars, so
  // it passes) and only then trim it to "" — storing an empty title, no error.
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters"),

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
    .max(200_000, "Content must be at most 200,000 characters"),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
