import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import type { DocStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import { chunkPages, chunkText } from "../../lib/chunk.js";
import { embed } from "../../lib/embed.js";
import { HttpError } from "../../lib/http-error.js";
import { DEFAULT_PAGE_SIZE } from "./document.schema.js";

// The ingestion pipeline: take a document's raw text and turn it into
// searchable, cite-able chunks. It ties together the two helpers you just
// wrote — chunkText (split) and embed (vectorize) — and persists the result.
//
// Note on scope: this takes `content` as already-extracted plain text. Turning
// a PDF/upload into text is a separate upstream concern (a parser — now
// lib/pdf.ts), so it stays out of here: this function only cares about text in,
// chunks out. That parser is also where the filename and mime type belong: the
// schema deliberately stores neither, only a human-facing `title`.

type IngestInput = {
  userId: string;
  title: string;
  content: string;
  // Present only when the source had page structure (a PDF, via lib/pdf.ts).
  // When given, chunking becomes page-aware so citations can name a page.
  //
  // WHY `content` IS STILL REQUIRED ALONGSIDE THIS, rather than deriving one
  // from the other:
  //   - `content` remains the reprocessing source of truth (see the schema
  //     comment on Document.content), so a future re-chunk needs no PDF.
  //   - dedupe hashes `content`, so a PDF and a paste of the same text collapse
  //     to one document. The caller must join `pages` the same way every time
  //     for that to hold — see uploadPdfDocument in document.routes.ts.
  pages?: string[];
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
  pages,
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
    //    One branch, one difference: page-aware splitting when the source had
    //    pages. Everything after this point is identical for both paths, which
    //    is the point of converting a PDF to text at the edge — the pipeline
    //    never learns that PDFs exist.
    const chunks = pages ? await chunkPages(pages) : await chunkText(content);

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
            // `?? null` rather than leaving it undefined: Prisma omits an
            // undefined field from the INSERT entirely, which happens to give
            // the same result here (the column is nullable) but stops being
            // equivalent the moment the column gains a default. Being explicit
            // costs nothing and says "no page" instead of "no opinion".
            page: c.page ?? null,
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

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

// The shape a document takes when it leaves the API. An explicit allow-list,
// not `select`-less "give me everything", because two columns must never go out
// over the wire:
//   - `content`, the full raw text. Returning it from the LIST endpoint would
//     mean a user with 50 documents downloads their entire corpus to render a
//     sidebar. It stays server-side, where it exists to be re-chunked.
//   - `embedding`, which is 1536 floats of no use to a client (Prisma wouldn't
//     return the Unsupported() column anyway, but the intent is the point).
//
// `error` IS included, so a FAILED document can explain itself in the list
// without the UI making a follow-up request per failed row.
const documentSelect = {
  id: true,
  title: true,
  status: true,
  chunkCount: true,
  error: true,
  createdAt: true,
} satisfies Prisma.DocumentSelect;

export type DocumentSummary = Prisma.DocumentGetPayload<{
  select: typeof documentSelect;
}>;

// A page of documents plus the cursor for the next one. `nextCursor` is null on
// the last page, which is ALSO how a client knows to stop — so it never needs a
// total count, and we never run the COUNT(*) that would produce one. (A total
// is a second query against a table that changes under you, and its only real
// consumer is a "page 3 of 7" control that a cursor API doesn't have.)
export type DocumentPage = {
  documents: DocumentSummary[];
  nextCursor: string | null;
};

// Newest first — the access pattern the composite index
// `@@index([userId, createdAt(sort: Desc)])` in schema.prisma exists to serve:
// Postgres seeks straight to this user's slice and walks it already ordered.
//
// CURSOR, NOT OFFSET (`skip`/`take`). This list is ordered newest-first and new
// documents arrive at the HEAD, so with offset pagination an upload between two
// requests shifts every row down by one — and page 2 re-serves the last row of
// page 1. Cursor pagination is anchored to a row, not to a count, so an insert
// at the head cannot disturb a page boundary further down.
//
// THE ORDER MUST BE TOTAL, WHICH `createdAt` ALONE IS NOT. `createdAt` carries
// no unique constraint, so two documents ingested in the same millisecond tie,
// and Postgres is free to order a tie differently between two queries. At a
// page boundary that means a row served twice or skipped entirely. Adding `id`
// as a tie-break makes the order deterministic; `id` is a random v4 UUID and so
// says nothing about time, but a tie-break only has to be STABLE, not
// chronological.
//
// (The index doesn't cover the `id` leg, so Postgres sorts within a tie group.
// Those groups are one or two rows, so extending the index buys nothing — and
// it would cost a hand-authored migration, since `migrate dev` is unsafe on
// this database. See the HNSW note in STATUS.md.)
export async function listDocuments({
  userId,
  limit = DEFAULT_PAGE_SIZE,
  cursor,
}: {
  userId: string;
  limit?: number;
  cursor?: string;
}): Promise<DocumentPage> {
  // WHY THE CURSOR IS RESOLVED SEPARATELY INSTEAD OF HANDED STRAIGHT TO PRISMA.
  //
  // Verified empirically against the real database rather than assumed: when
  // `cursor` names a row the `where` clause excludes — another user's document,
  // or an id that exists nowhere — Prisma does NOT throw. It resolves to `[]`.
  //
  // That is good for security and bad for the user. Good, because the two cases
  // are indistinguishable, so the response can't be used as an oracle to test
  // whether a document id exists (the same reasoning that makes getDocument
  // answer 404 rather than 403). Bad, because a client holding a stale cursor
  // gets an empty page, and an empty page renders as "you have no documents" —
  // a wrong and alarming answer to a request that should just work.
  //
  // So: resolve the cursor against THIS user first. Found, we paginate from it;
  // not found, we fall back to the first page. Both failure cases still return
  // byte-identical responses, so the oracle stays closed while the stale-cursor
  // case quietly heals itself. Costs one primary-key lookup.
  const cursorRow = cursor
    ? await prisma.document.findFirst({
        where: { id: cursor, userId },
        select: { id: true },
      })
    : null;

  // Ask for ONE more row than the caller wanted. If it comes back, there is at
  // least one more document after this page — which is the entire "is there a
  // next page" question, answered by the query we were already running instead
  // of by a second COUNT(*).
  const rows = await prisma.document.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: documentSelect,
    take: limit + 1,
    // `skip: 1` skips the cursor row ITSELF. Without it the row the client sent
    // us comes back as the first item of the next page, so every page after the
    // first opens with a duplicate of the one before it.
    ...(cursorRow ? { cursor: { id: cursorRow.id }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  // Drop the probe row before it reaches the client — it belongs to the next
  // page, and returning it would make `limit` a lie by exactly one.
  const documents = hasMore ? rows.slice(0, limit) : rows;

  return {
    documents,
    nextCursor: hasMore ? documents[documents.length - 1].id : null,
  };
}

export async function getDocument({
  userId,
  id,
}: {
  userId: string;
  id: string;
}): Promise<DocumentSummary> {
  // `userId` goes in the WHERE clause — it is NOT a check performed after the
  // fact. The tempting alternative,
  //
  //     const doc = await prisma.document.findUnique({ where: { id } });
  //     if (doc.userId !== userId) throw new HttpError(403, ...);
  //
  // is one forgotten `if` away from an IDOR: any logged-in user could read any
  // document by guessing its id. Scoping the query makes the ownership rule
  // structural, so it cannot be omitted by a future edit.
  //
  // (findFirst rather than findUnique because `{ id, userId }` isn't a declared
  // unique key. It still resolves via the primary-key index on `id`.)
  const document = await prisma.document.findFirst({
    where: { id, userId },
    select: documentSelect,
  });

  // 404 rather than 403 for a document that exists but belongs to someone else.
  // A 403 would confirm the id is real, letting an attacker enumerate ids to
  // map another user's library — the response itself becomes the oracle. This
  // deliberately collapses "no such document" and "not yours" into one
  // indistinguishable answer, which is also just what the query above returns.
  if (!document) throw new HttpError(404, "Document not found");

  return document;
}
