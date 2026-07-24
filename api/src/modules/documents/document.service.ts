import { prisma } from "../../lib/prisma";
import { chunkText } from "../../lib/chunk";
import { embed } from "../../lib/embed";
import { HttpError } from "../../lib/http-error";

// The ingestion pipeline: take a document's raw text and turn it into
// searchable, cite-able chunks. It ties together the two helpers you just
// wrote — chunkText (split) and embed (vectorize) — and persists the result.
//
// Note on scope: this takes `content` as already-extracted plain text. Turning
// a PDF/upload into text is a separate upstream concern (a parser), so it stays
// out of here — this function only cares about text in, chunks out.

type IngestInput = {
  userId: string;
  filename: string;
  mimeType: string;
  content: string;
};

export async function ingestDocument({
  userId,
  filename,
  mimeType,
  content,
}: IngestInput) {
  // 1. Create the Document row first, so there's a durable record to track
  //    while the (potentially slow) async work runs. It defaults to PENDING.
  const doc = await prisma.document.create({
    data: { userId, filename, mimeType },
  });

  try {
    // Flip to PROCESSING so a UI polling `status` can show a spinner. This is
    // why ingestion is modelled as a state machine (see DocStatus enum) rather
    // than a single blocking call — the frontend never has to wait on us.
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "PROCESSING" },
    });

    // 2. Split → embed. Both run OUTSIDE any DB transaction on purpose:
    //    chunking is CPU work and embedding is a network round-trip to OpenAI.
    //    Holding a Postgres transaction open across a slow external API call
    //    would pin a connection and invite timeouts — a classic footgun.
    const chunks = await chunkText(content);

    if (chunks.length === 0) {
      // Empty/whitespace-only input — nothing to embed. Still a valid outcome.
      await prisma.document.update({
        where: { id: doc.id },
        data: { status: "READY" },
      });
      return { id: doc.id, status: "READY" as const, chunkCount: 0 };
    }

    // `vectors` comes back aligned to `chunks` by position (embed preserves
    // order), and chunk.chunkIndex === its array position, so index `i` lines
    // up across all three: chunks[i], vectors[i], chunkIndex i.
    const vectors = await embed(chunks.map((c) => c.content));

    // 3. Persist everything in ONE transaction, so a mid-write failure can't
    //    leave half the chunks saved with the document marked READY.
    //    The default interactive-transaction timeout is 5s; we bump it because
    //    a large document means many per-row embedding UPDATEs.
    await prisma.$transaction(
      async (tx) => {
        // Prisma can't write the `Unsupported("vector(1536)")` column through
        // createMany, so we do this in two moves: insert the text columns
        // (Prisma generates the cuid ids)...
        await tx.chunk.createMany({
          data: chunks.map((c) => ({
            documentId: doc.id,
            content: c.content,
            chunkIndex: c.chunkIndex,
          })),
        });

        // ...then set each embedding via raw SQL, casting the text literal
        // `[0.1,0.2,...]` to pgvector's `vector` type. We match rows by
        // (documentId, chunkIndex) — a natural key here — so we don't need to
        // read the generated ids back.
        for (let i = 0; i < chunks.length; i++) {
          const literal = `[${vectors[i].join(",")}]`;
          await tx.$executeRaw`
            UPDATE "Chunk"
            SET embedding = ${literal}::vector
            WHERE "documentId" = ${doc.id} AND "chunkIndex" = ${chunks[i].chunkIndex}
          `;
        }

        await tx.document.update({
          where: { id: doc.id },
          data: { status: "READY" },
        });
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    return { id: doc.id, status: "READY" as const, chunkCount: chunks.length };
  } catch (err) {
    // Best-effort: record the failure so the doc doesn't sit stuck in
    // PROCESSING forever. Swallow any error from this update — we want to
    // surface the ORIGINAL failure, not mask it.
    await prisma.document
      .update({ where: { id: doc.id }, data: { status: "FAILED" } })
      .catch(() => {});

    throw err instanceof HttpError
      ? err
      : new HttpError(500, "Failed to ingest document");
  }
}
