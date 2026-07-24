import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export type ChunkInput = { content: string; chunkIndex: number };
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
