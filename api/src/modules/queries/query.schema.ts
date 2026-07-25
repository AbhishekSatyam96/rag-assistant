import { z } from "zod";

// Same discipline as document.schema.ts, including the ordering trap: `.trim()`
// comes BEFORE `.min(1)`. Reversed, zod measures the raw string — "   " is
// three characters, passes min(1) — and only then trims, so an empty question
// reaches the embedder and gets billed for embedding nothing.
//
// No `userId` here, for the same reason as document.schema.ts: ownership comes
// from the verified token and must never be something a client can send. And no
// `chunkIds` or similar — letting a caller nominate which chunks to answer from
// would hand them a way to read rows the retrieval scope was meant to gate.
export const askSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Question is required")
    // 1000 chars is far more than a real question and still far below the
    // embedding model's 8191-token input limit, so an over-long question fails
    // here with a clear field error instead of as an opaque 400 from OpenAI.
    .max(1000, "Question must be at most 1000 characters"),

  // How many chunks to retrieve. Exposed because it is the single most useful
  // knob when tuning answer quality, and capped because it feeds straight into
  // the model's context window — an uncapped `k` is a way for a client to make
  // us send an arbitrarily large (and expensive) prompt.
  //
  // `.int()` matters: k reaches SQL as a LIMIT, and LIMIT 2.5 is an error from
  // Postgres, i.e. a 500 for what is really a bad request.
  k: z.number().int().min(1).max(10).default(5),
});

export type AskInput = z.infer<typeof askSchema>;
