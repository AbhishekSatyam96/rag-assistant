import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createDocumentSchema,
  listDocumentsQuerySchema,
  uploadDocumentSchema,
  CONTENT_MAX,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
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

describe("listDocumentsQuerySchema", () => {
  // Everything here arrives from `req.query`, so every value is a STRING. These
  // tests exist because the coercion needed to handle that is also what opens
  // the door to `0` and `NaN` sneaking through as valid numbers.

  it("defaults limit when the param is absent", () => {
    assert.equal(listDocumentsQuerySchema.parse({}).limit, DEFAULT_PAGE_SIZE);
  });

  it("coerces a numeric string, because query params are never numbers", () => {
    // A plain z.number() would reject "20" outright — this is the one field in
    // the file that MUST coerce.
    assert.equal(listDocumentsQuerySchema.parse({ limit: "20" }).limit, 20);
  });

  it("rejects limit=0 — Number('') is 0, so this is the `?limit=` case too", () => {
    assert.equal(listDocumentsQuerySchema.safeParse({ limit: "0" }).success, false);
  });

  it("rejects a limit above the ceiling", () => {
    // The ceiling is the whole point: without it `?limit=999999` reads a user's
    // entire library in one request.
    const result = listDocumentsQuerySchema.safeParse({
      limit: String(MAX_PAGE_SIZE + 1),
    });

    assert.equal(result.success, false);
  });

  it("accepts a limit exactly at the ceiling", () => {
    assert.equal(
      listDocumentsQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) }).limit,
      MAX_PAGE_SIZE,
    );
  });

  it("rejects a non-numeric limit, which coerces to NaN and not to a type error", () => {
    // `typeof NaN === "number"`, so the type check PASSES here. `.int()` is what
    // actually rejects it — remove it and `?limit=abc` becomes `take: NaN`.
    assert.equal(listDocumentsQuerySchema.safeParse({ limit: "abc" }).success, false);
  });

  it("rejects a fractional limit", () => {
    assert.equal(listDocumentsQuerySchema.safeParse({ limit: "2.5" }).success, false);
  });

  it("rejects a repeated limit param, which Express hands over as an array", () => {
    // `?limit=1&limit=2`. Number(["1","2"]) is NaN, so this lands on the same
    // guard as "abc" — a clean 400 rather than a surprise deeper in.
    assert.equal(listDocumentsQuerySchema.safeParse({ limit: ["1", "2"] }).success, false);
  });

  it("treats an empty cursor as absent rather than invalid", () => {
    // `?cursor=` MEANS "no cursor". Without the preprocess it would fail
    // .min(1) and 400 a perfectly reasonable request for the first page.
    assert.equal(listDocumentsQuerySchema.parse({ cursor: "" }).cursor, undefined);
  });

  it("passes a cursor through untouched — it is opaque to this layer", () => {
    const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    assert.equal(listDocumentsQuerySchema.parse({ cursor: id }).cursor, id);
  });

  it("strips unknown query params", () => {
    // Same free mass-assignment protection as the body schemas: a client that
    // sends `?userId=someone-else` has it dropped before the service sees it.
    const parsed = listDocumentsQuerySchema.parse({ userId: "attacker", limit: "5" });
    assert.equal("userId" in parsed, false);
  });
});
