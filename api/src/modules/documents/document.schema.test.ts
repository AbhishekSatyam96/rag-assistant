import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createDocumentSchema,
  uploadDocumentSchema,
  CONTENT_MAX,
  TITLE_MAX,
} from "./document.schema.js";

// Validation is the layer where a decision is either enforced or merely
// documented. Every test below pins a comment in document.schema.ts to an
// assertion, so the reasoning cannot rot away from the behaviour.

describe("createDocumentSchema", () => {
  it("rejects a whitespace-only title", () => {
    // THE ORDERING TRAP. zod runs `.trim()` and `.min(1)` left to right, so
    // `.min(1).trim()` measures the RAW string — "   " is three characters and
    // passes — and only then trims it to "", storing an empty title with no
    // error anywhere. This test fails the instant someone reorders them.
    const result = createDocumentSchema.safeParse({
      title: "   ",
      content: "Real content.",
    });

    assert.equal(result.success, false);
  });

  it("rejects whitespace-only content", () => {
    const result = createDocumentSchema.safeParse({
      title: "Title",
      content: " \n\t ",
    });

    assert.equal(result.success, false);
  });

  it("returns the trimmed values, not the submitted ones", () => {
    // The parsed output is what reaches the service — and `content` is what
    // gets sha256'd for dedupe, so trimming here is what makes the same text
    // pasted with stray whitespace count as the same document.
    const result = createDocumentSchema.parse({
      title: "  Handbook  ",
      content: "  Body text.  ",
    });

    assert.equal(result.title, "Handbook");
    assert.equal(result.content, "Body text.");
  });

  it("strips unknown keys instead of rejecting them", () => {
    // Free mass-assignment protection, and the reason `userId` is absent from
    // the schema rather than rejected by it: a client POSTing `userId` to write
    // into someone else's library, or `status: "READY"` to skip ingestion, has
    // the field silently dropped. Asserted with a cast because the whole point
    // is that these keys are not in the input type.
    const result = createDocumentSchema.parse({
      title: "Title",
      content: "Body",
      userId: "some-other-users-id",
      status: "READY",
      chunkCount: 999,
    } as Record<string, unknown>);

    assert.deepEqual(Object.keys(result).sort(), ["content", "title"]);
  });

  it("accepts content exactly at the cap and rejects one character more", () => {
    // CONTENT_MAX sits deliberately below express.json({ limit: "1mb" }), so an
    // oversized paste gets a field-level 400 here instead of an opaque 413 from
    // body-parser. An off-by-one at the boundary is the classic way that
    // layering breaks, so both sides of it are pinned.
    const atCap = "a".repeat(CONTENT_MAX);
    const overCap = "a".repeat(CONTENT_MAX + 1);

    assert.equal(
      createDocumentSchema.safeParse({ title: "T", content: atCap }).success,
      true,
    );
    assert.equal(
      createDocumentSchema.safeParse({ title: "T", content: overCap }).success,
      false,
    );
  });

  it("rejects a title over the cap", () => {
    const result = createDocumentSchema.safeParse({
      title: "t".repeat(TITLE_MAX + 1),
      content: "Body",
    });

    assert.equal(result.success, false);
  });

  it("requires both fields", () => {
    assert.equal(createDocumentSchema.safeParse({ title: "T" }).success, false);
    assert.equal(createDocumentSchema.safeParse({ content: "C" }).success, false);
  });
});

describe("uploadDocumentSchema", () => {
  it("treats an empty multipart title as absent, not as invalid", () => {
    // Multipart-specific: an untouched form field arrives as "" rather than as
    // a missing key. Without the preprocess step, leaving the title box blank
    // fails `.min(1)` and 400s a request that is perfectly reasonable — the
    // user meant "use the filename", which the route then does.
    const result = uploadDocumentSchema.parse({ title: "" });

    assert.equal(result.title, undefined);
  });

  it("treats a whitespace-only multipart title as absent", () => {
    assert.equal(uploadDocumentSchema.parse({ title: "   " }).title, undefined);
  });

  it("still enforces the length cap on a title that IS supplied", () => {
    // `.optional()` must not become an escape hatch from the shared rules —
    // this is why the field reuses titleSchema rather than an inline `string()`.
    const result = uploadDocumentSchema.safeParse({
      title: "t".repeat(TITLE_MAX + 1),
    });

    assert.equal(result.success, false);
  });

  it("accepts a request with no title field at all", () => {
    assert.equal(uploadDocumentSchema.safeParse({}).success, true);
  });
});
