import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { askSchema } from "./query.schema.js";

describe("askSchema", () => {
  it("defaults k to 5 when omitted", () => {
    // The number M7 exists to either confirm or overturn. Pinned here so that
    // changing it is a deliberate edit to two places rather than a drive-by
    // tweak in one — see also DEFAULT_K in lib/retrieve.ts, which must agree.
    const result = askSchema.parse({ question: "What is HNSW?" });

    assert.equal(result.k, 5);
  });

  it("rejects a non-integer k", () => {
    // `.int()` is load-bearing, not decoration: k reaches Postgres as a LIMIT,
    // and `LIMIT 2.5` is a syntax error — i.e. a 500 for what is really a bad
    // request. Failing here turns it into a 400 with a field message.
    assert.equal(askSchema.safeParse({ question: "q", k: 2.5 }).success, false);
  });

  it("rejects k outside 1..10 at both ends", () => {
    // The upper bound is a cost control: k feeds straight into the model's
    // context window, so an uncapped k is a way for a client to make us send an
    // arbitrarily large — and arbitrarily expensive — prompt.
    assert.equal(askSchema.safeParse({ question: "q", k: 0 }).success, false);
    assert.equal(askSchema.safeParse({ question: "q", k: 11 }).success, false);
    assert.equal(askSchema.safeParse({ question: "q", k: 1 }).success, true);
    assert.equal(askSchema.safeParse({ question: "q", k: 10 }).success, true);
  });

  it("rejects a whitespace-only question", () => {
    // Same `.trim()`-before-`.min(1)` ordering trap as document.schema.ts. The
    // cost of getting it wrong is different here though: an empty question
    // reaches the embedder and we pay OpenAI to embed nothing, then retrieve
    // the corpus's arbitrary "average" chunks and present them as a real hit.
    assert.equal(askSchema.safeParse({ question: "   " }).success, false);
  });

  it("trims the question it returns", () => {
    assert.equal(askSchema.parse({ question: "  What is HNSW?  " }).question, "What is HNSW?");
  });

  it("rejects a question over 1000 characters", () => {
    // Well below the embedding model's 8191-token input limit, so an over-long
    // question fails here with a clear field error instead of as an opaque 400
    // relayed from OpenAI.
    assert.equal(askSchema.safeParse({ question: "q".repeat(1001) }).success, false);
    assert.equal(askSchema.safeParse({ question: "q".repeat(1000) }).success, true);
  });

  it("strips unknown keys, including any attempt to nominate chunks", () => {
    // `userId` is absent for the usual reason (ownership comes from the token).
    // `chunkIds` is absent for a sharper one: letting a caller name the chunks
    // to answer from would hand them a way to read rows that the tenant scope
    // in retrieve.ts exists to gate.
    const result = askSchema.parse({
      question: "q",
      userId: "someone-else",
      chunkIds: ["c1", "c2"],
    } as Record<string, unknown>);

    assert.deepEqual(Object.keys(result).sort(), ["k", "question"]);
  });
});
