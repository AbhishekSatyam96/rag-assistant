import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkText, chunkPages } from "./chunk.js";

// Pure unit tests: no database, no network, no money. chunkText/chunkPages take
// strings and return objects, which makes them the cheapest useful thing in the
// suite and the right place to start.
//
// These matter more than they look. `chunkIndex` is the natural key that
// document.service.ts matches on when it writes each embedding
// (`WHERE "documentId" = ... AND "chunkIndex" = ...`), so a gap or a duplicate
// here does not throw — it silently writes a vector onto the wrong row, or onto
// no row at all. The symptom appears much later as "retrieval returns the wrong
// passage", with nothing pointing back to this file.

describe("chunkText", () => {
  it("numbers chunks contiguously from 0", async () => {
    // Long enough to force several splits at the default chunkSize of 1000.
    const text = "Retrieval augmented generation grounds answers in your text. ".repeat(
      120,
    );

    const chunks = await chunkText(text);

    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assert.deepEqual(
      chunks.map((c) => c.chunkIndex),
      chunks.map((_, i) => i),
    );
  });

  it("never emits an empty or untrimmed chunk", async () => {
    // Deliberately pathological spacing: blank lines are exactly what the
    // recursive splitter breaks on first, so this is the input most likely to
    // produce whitespace-only fragments.
    const text = "alpha\n\n\n\n   \n\n beta \n\n\n\n   \n\n gamma";

    const chunks = await chunkText(text, { chunkSize: 10, chunkOverlap: 0 });

    for (const chunk of chunks) {
      assert.notEqual(chunk.content, "");
      assert.equal(chunk.content, chunk.content.trim());
    }
  });

  it("returns nothing for whitespace-only input", async () => {
    // The branch document.service.ts relies on to mark a document READY with
    // zero chunks instead of calling the embedder with an empty array.
    assert.deepEqual(await chunkText("   \n\n\t  "), []);
  });

  it("leaves no page number on text that never had pages", async () => {
    // Not a formality. `page` is what turns a citation into "page 7", and a
    // pasted document must render the null branch in the UI forever — see the
    // comment on Source.page in query.service.ts.
    const chunks = await chunkText("A short pasted note about vector search.");

    assert.ok(chunks.every((c) => c.page === undefined));
  });

  it("overlaps consecutive chunks so a boundary sentence stays retrievable", async () => {
    // The reason chunkOverlap exists at all. Sentence-shaped input so the
    // splitter has real boundaries to choose from rather than splitting words.
    const text = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} explains one idea about retrieval.`,
    ).join(" ");

    const chunks = await chunkText(text, { chunkSize: 300, chunkOverlap: 100 });

    assert.ok(chunks.length > 2, "need at least three chunks to test a seam");

    // The tail of chunk n must reappear somewhere in chunk n+1. Compared on a
    // short slice rather than the full overlap window because the splitter
    // snaps to natural boundaries, so the overlap is "about 100 chars", not
    // exactly 100 — asserting the exact number would test the library's
    // internals instead of the property we actually depend on.
    const tail = chunks[0].content.slice(-40);
    assert.ok(
      chunks[1].content.includes(tail),
      "chunk 1 does not contain the tail of chunk 0 — overlap is not happening",
    );
  });
});

describe("chunkPages", () => {
  it("attributes each chunk to its 1-based page", async () => {
    const pages = ["Content of the first page.", "Content of the second page."];

    const chunks = await chunkPages(pages);

    assert.deepEqual(
      chunks.map((c) => c.page),
      [1, 2],
    );
  });

  it("keeps page numbers correct when a blank page is skipped", async () => {
    // Section dividers and back matter are genuinely blank. The page number
    // comes from the loop index, not from a position in a filtered array —
    // this test is what stops someone "simplifying" that into an off-by-one
    // that is invisible until a reader opens the PDF to check a citation.
    const pages = ["First page text.", "   \n  ", "Third page text."];

    const chunks = await chunkPages(pages);

    assert.deepEqual(
      chunks.map((c) => c.page),
      [1, 3],
    );
  });

  it("runs chunkIndex continuously across page boundaries", async () => {
    // chunkIndex is document-scoped, page is page-scoped. Resetting the index
    // per page would produce duplicate (documentId, chunkIndex) pairs, and the
    // embedding UPDATE in document.service.ts matches on exactly that pair — so
    // one page's vectors would overwrite another's.
    const pages = [
      "Alpha ".repeat(400), // several chunks
      "Beta ".repeat(400), // several more
    ];

    const chunks = await chunkPages(pages, { chunkSize: 200, chunkOverlap: 20 });

    assert.deepEqual(
      chunks.map((c) => c.chunkIndex),
      chunks.map((_, i) => i),
    );
    // And the page label must actually change partway through, otherwise the
    // assertion above would also pass for a single-page document.
    assert.equal(new Set(chunks.map((c) => c.page)).size, 2);
  });

  // CHARACTERIZATION TEST — this asserts behaviour we currently consider WRONG.
  //
  // Splitting each page independently makes the page a hard chunk boundary, so
  // a PDF of short pages yields one tiny chunk per page instead of a few
  // well-sized ones (the limitation documented at length in chunk.ts). Tiny
  // chunks embed into vague vectors and retrieve badly.
  //
  // It is pinned here rather than left implicit so that M7's hit-rate numbers
  // decide whether to fix it, and so that the eventual merge pass announces
  // itself by failing this test instead of silently changing what "page" means.
  it("does NOT merge short pages — one chunk per page, however small", async () => {
    const pages = ["One.", "Two.", "Three.", "Four."];

    const chunks = await chunkPages(pages, { chunkSize: 1000, chunkOverlap: 200 });

    assert.equal(
      chunks.length,
      4,
      "short pages merged — if this is the deliberate fix, update this test and chunk.ts's comment together",
    );
  });
});
