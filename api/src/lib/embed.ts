import { openai } from "./openai.js";

const EMBED_MODEL = "text-embedding-3-small"; // 1536 dims — must match vector(1536)
const BATCH_SIZE = 100;

export async function embed(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];

  // The API caps how many inputs it'll embed per call, so we send `texts` in
  // batches instead of one giant request. We walk the array in strides of
  // BATCH_SIZE and append each batch's results, which keeps the output aligned
  // with the input order (batch 0 first, then batch 1, ...).
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });

    // res.data comes back in the same order as `batch`, but sort by `index`
    // defensively so we never rely on that ordering being preserved.
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) vectors.push(item.embedding);
  }

  // Same length and order as `texts` — the caller can zip these back onto
  // their chunks by position.
  return vectors;
}