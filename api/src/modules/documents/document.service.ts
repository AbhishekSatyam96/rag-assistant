import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { DocStatus } from "../../generated/prisma/enums";
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
// out of here — this function only cares about text in, chunks out. That parser
// is also where the filename and mime type belong: the schema deliberately
// stores neither, only a human-facing `title`.

type IngestInput = {
  userId: string;
  title: string;
  content: string;
  // A seam for tests: swap in a stub embedder to exercise the DB path without
  // paying for (or depending on the availability of) a real OpenAI call.
  // Production callers omit it and get the real `embed`.
  embedFn?: typeof embed;
};

type IngestResult = {
  id: string;
  status: DocStatus;
  chunkCount: number;
  // True when this content was already ingested and we returned the existing
  // document untouched. Callers that care (an HTTP layer picking 201 vs 200)
  // can branch on it; callers that don't can ignore it.
  deduped: boolean;
};

// A fingerprint of the text, not a secret — so plain sha256: no salt, no slow
// KDF. That's the exact opposite of password hashing (see lib/password.ts),
// and for the opposite reason: here we WANT identical input to collide.
function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// `@@unique([userId, contentHash])` is enforced by Postgres, and a violation
// arrives as Prisma error P2002.
function isDuplicateContent(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function findByHash(userId: string, contentHash: string) {
  return prisma.document.findUnique({
    where: { userId_contentHash: { userId, contentHash } },
  });
}

function dedupedResult(doc: {
  id: string;
  status: DocStatus;
  chunkCount: number;
}): IngestResult {
  return {
    id: doc.id,
    status: doc.status,
    chunkCount: doc.chunkCount,
    deduped: true,
  };
}

export async function ingestDocument({
  userId,
  title,
  content,
  embedFn = embed,
}: IngestInput): Promise<IngestResult> {
  const contentHash = hashContent(content);

  // 1. Dedupe BEFORE doing any work. Re-uploading the same file is the common
  //    case (a user retries, or syncs a folder twice), and embedding is the
  //    expensive step — we'd be paying OpenAI to compute vectors we already
  //    have. Ingestion is therefore idempotent per (user, content): same text
  //    in, same document id out.
  const existing = await findByHash(userId, contentHash);
  if (existing) return dedupedResult(existing);

  // 2. Create the Document row, so there's a durable record to track while the
  //    (potentially slow) async work runs. It defaults to PENDING.
  //
  //    This create sits in its OWN try/catch, separate from the pipeline below,
  //    because until it succeeds there is no row to mark FAILED.
  let doc: { id: string };
  try {
    doc = await prisma.document.create({
      data: { userId, title, content, contentHash },
    });
  } catch (err) {
    // The check above is an optimisation; the constraint is the guarantee. Two
    // concurrent requests can both pass `findByHash` and then race to insert —
    // one wins, the other lands here. Return the winner's row rather than
    // failing a request that asked for something that now exists.
    if (isDuplicateContent(err)) {
      const winner = await findByHash(userId, contentHash);
      if (winner) return dedupedResult(winner);
    }

    throw err instanceof HttpError
      ? err
      : new HttpError(500, "Failed to create document", { cause: err });
  }

  try {
    // Flip to PROCESSING so a UI polling `status` can show a spinner. This is
    // why ingestion is modelled as a state machine (see DocStatus enum) rather
    // than a single blocking call — the frontend never has to wait on us.
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "PROCESSING" },
    });

    // 3. Split → embed. Both run OUTSIDE any DB transaction on purpose:
    //    chunking is CPU work and embedding is a network round-trip to OpenAI.
    //    Holding a Postgres transaction open across a slow external API call
    //    would pin a connection and invite timeouts — a classic footgun.
    const chunks = await chunkText(content);

    if (chunks.length === 0) {
      // Empty/whitespace-only input — nothing to embed. Still a valid outcome.
      await prisma.document.update({
        where: { id: doc.id },
        data: { status: "READY", chunkCount: 0 },
      });
      return { id: doc.id, status: "READY", chunkCount: 0, deduped: false };
    }

    // `vectors` comes back aligned to `chunks` by position (embed preserves
    // order), and chunk.chunkIndex === its array position, so index `i` lines
    // up across all three: chunks[i], vectors[i], chunkIndex i.
    const vectors = await embedFn(chunks.map((c) => c.content));

    // 4. Persist everything in ONE transaction, so a mid-write failure can't
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

        // chunkCount is denormalised onto Document on purpose: listing a user's
        // documents shouldn't need a COUNT(*) join against Chunk. It's written
        // inside the same transaction as the rows it counts, so it can't drift.
        await tx.document.update({
          where: { id: doc.id },
          data: { status: "READY", chunkCount: chunks.length },
        });
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    return {
      id: doc.id,
      status: "READY",
      chunkCount: chunks.length,
      deduped: false,
    };
  } catch (err) {
    // Best-effort: record the failure so the doc doesn't sit stuck in
    // PROCESSING forever, and stash the reason in `error` so the user can be
    // told WHY rather than just "failed". Swallow any error from this update —
    // we want to surface the ORIGINAL failure, not mask it.
    await prisma.document
      .update({
        where: { id: doc.id },
        data: {
          status: "FAILED",
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});

    throw err instanceof HttpError
      ? err
      : new HttpError(500, "Failed to ingest document", { cause: err });
  }
}
