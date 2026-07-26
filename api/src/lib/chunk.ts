import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// `page` is set only when the source had pages (a PDF). Pasted text has no
// page structure, so it stays undefined there — and undefined forever, which is
// why every consumer treats it as optional rather than as a value that will
// arrive later.
export type ChunkInput = { content: string; chunkIndex: number; page?: number };
export type ChunkOption = { chunkSize?: number; chunkOverlap?: number };

// How big each chunk is (in characters) and how much neighbouring chunks share.
// Overlap keeps a sentence that straddles a boundary retrievable from either
// side, so a citation isn't lost just because it landed on the seam.
// (Frontend analogy: like a sticky header — the last lines of one section stay
// visible as you scroll into the next.)

export async function chunkText(
  text: string,
  { chunkSize = 1000, chunkOverlap = 200 }: ChunkOption = {},
): Promise<ChunkInput[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });

  // "Recursive" = it tries to break on the largest natural boundary first
  // (paragraphs, then lines, then sentences, then words) so chunks stay coherent
  // instead of being sliced mid-word every 1000 chars.
  const parts = await splitter.splitText(text);

  // chunkIndex is the ordinal within the document — it maps 1:1 to Chunk.chunkIndex
  // in the schema, which is what makes each chunk cite-able later.
  return parts
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((content, chunkIndex) => ({ content, chunkIndex }));
}

// The PDF path: split each page INDEPENDENTLY, so every chunk knows which page
// it came from and a citation can say "page 7" instead of "chunk 12". That is
// the entire reason PDF support is worth having over "paste the text" — it is
// the one thing the file format gives us that a string cannot.
//
// `chunkIndex` still runs continuously across the whole document (it is the
// document-level ordinal, and the natural key document.service.ts matches on
// when it writes embeddings), while `page` resets to the real page number.
//
// THE TRADEOFF, because it is not free:
//
//   1. A paragraph straddling a page break gets split, and `chunkOverlap`
//      cannot bridge it — overlap only applies WITHIN one splitter call.
//      Accepted deliberately: a chunk spanning two pages has no single honest
//      page number to cite, and a wrong citation is worse than a split one.
//
//   2. `chunkSize` is a MAXIMUM, not a target, and this imposes a second
//      maximum that never appears in the config: the page length. A 300-page
//      PDF with one short paragraph per page yields ~300 tiny chunks instead of
//      ~45 well-sized ones. Small chunks embed into vague vectors, so retrieval
//      matches on surface keywords rather than meaning, and `k = 5` then feeds
//      the model a fraction of the context it would otherwise get — which
//      surfaces as the model hedging or refusing, and looks like a prompt bug.
//
//      The fix is a merge pass: accumulate consecutive short pages until they
//      approach chunkSize, then emit one chunk. That needs a page RANGE on
//      Chunk (or a start-page convention), which the single `page Int?` column
//      cannot express — so it is a schema change, not a tweak here.
//
//      Not built yet, on purpose. Whether it matters depends entirely on the
//      corpus (dense pages make the problem vanish), and the eval harness is
//      the thing that can answer that with a number instead of a guess. Ship
//      the simple version, measure hit-rate@k against whole-document chunking,
//      then change it if the data says so.
export async function chunkPages(
  pages: string[],
  { chunkSize = 1000, chunkOverlap = 200 }: ChunkOption = {},
): Promise<ChunkInput[]> {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });

  const chunks: ChunkInput[] = [];

  for (let i = 0; i < pages.length; i++) {
    // Pages are 1-based for humans; the array is 0-based. Getting this wrong is
    // invisible until someone opens the PDF to check a citation.
    const page = i + 1;

    // Blank pages are real and common (section dividers, back matter). Skipping
    // them here rather than filtering later keeps `page` accurate, because the
    // page number comes from the index, not from a position in a filtered list.
    const text = pages[i].trim();
    if (!text) continue;

    const parts = await splitter.splitText(text);

    for (const part of parts) {
      const content = part.trim();
      if (!content) continue;
      chunks.push({ content, chunkIndex: chunks.length, page });
    }
  }

  return chunks;
}
