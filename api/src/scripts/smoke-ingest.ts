import { prisma } from "../lib/prisma.js";
import { ingestDocument } from "../modules/documents/document.service.js";

// Smoke test for the M4 ingestion pipeline — the FIRST time this code makes a
// real OpenAI call and a real write to Neon. It exists to prove the pipeline
// works in isolation, before any HTTP layer sits on top of it: if something
// breaks here, there are only three suspects (chunk, embed, persist) instead of
// six. Run it with:  pnpm smoke:ingest   (add --keep to leave the rows behind)
//
// This is not a unit test — it hits the live DB and a paid API on purpose.
// Cost is a rounding error (a few thousand tokens of text-embedding-3-small).
//
// Pass --fake to substitute a deterministic stub embedder. That skips OpenAI
// entirely and still exercises everything else: chunking, the two-step pgvector
// write, the transaction, the status machine and the FK cascades. Useful when
// the OpenAI account is out of quota, or in CI where you don't want a paid
// dependency — but it proves nothing about the embedding call itself.

// A dedicated account so cleanup can never touch a real one. Note the password
// column holds a placeholder, NOT a valid argon2 hash — this user deliberately
// cannot log in, so no usable credentials live in the repo.
const SMOKE_EMAIL = "smoke@local.test";
const KEEP = process.argv.includes("--keep");
const FAKE = process.argv.includes("--fake");

// A stand-in for the real embedder: same shape (1536 floats per input, output
// aligned to input order), no network call. The vector is derived from the text
// itself via a cheap xorshift PRNG, so it is deterministic across runs AND
// different for every chunk — which is what keeps the "each chunk has a
// distinct embedding" check meaningful. These vectors carry no meaning; they
// would be useless for retrieval, they only prove the plumbing.
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      let seed = 1;
      for (let i = 0; i < text.length; i++) {
        seed = (Math.imul(seed, 31) + text.charCodeAt(i)) >>> 0;
      }
      seed ||= 1; // xorshift is stuck at zero forever if it ever hits zero

      return Array.from({ length: 1536 }, () => {
        seed ^= seed << 13;
        seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return (seed / 0xffffffff) * 2 - 1; // [-1, 1)
      });
    }),
  );
}

// Long enough to split into several chunks at the default chunkSize of 1000,
// which is the point: a single-chunk document would never exercise the batching,
// the ordering, or the per-row embedding UPDATE.
const SAMPLE_TEXT = `
Retrieval-augmented generation (RAG) is a technique for grounding a language
model's answers in a specific body of text that the model was never trained on.
Instead of fine-tuning weights, the system retrieves the most relevant passages
from a document store at query time and passes them to the model as context.
The model then answers using that context, which makes the response traceable:
every claim can be attributed back to a passage the retriever actually found.

Chunking is the first step of the pipeline. A document is split into smaller
passages because embedding models have a bounded input size, and because a
retriever that returns an entire 50-page PDF has not really narrowed anything
down. The size of a chunk is a trade-off. Chunks that are too large dilute the
embedding, mixing several topics into one vector so it matches everything and
nothing. Chunks that are too small lose the surrounding context that made the
passage meaningful in the first place, and a citation pointing at a single
orphaned sentence is rarely convincing to a reader.

Overlap softens the seams between chunks. When consecutive chunks share a
trailing window of text, a sentence that happens to straddle a boundary still
appears in full inside at least one chunk, so it stays retrievable rather than
being cut in half and lost. The cost of overlap is duplication: the same words
are stored and embedded more than once, which inflates both storage and the
embedding bill. A common starting point is a chunk of roughly one thousand
characters with two hundred characters of overlap, tuned later against a real
evaluation set rather than guessed at once and left alone.

Embeddings turn each chunk into a fixed-length vector of floating point numbers
that encodes its meaning, so that passages about similar topics land near each
other in the vector space. Retrieval is then a nearest-neighbour search: embed
the user's question with the same model, and find the chunks whose vectors sit
closest to it, typically by cosine distance. Because both sides of the
comparison must live in the same space, the query and the documents have to be
embedded by the same model — mixing models produces vectors that are numerically
comparable but semantically meaningless.
`.trim();

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  (${detail})` : ""}`);
}

// The embedding column is Unsupported() in the schema, so Prisma's typed client
// refuses to select it. Raw SQL is the only way to inspect what actually landed.
// vector_dims() is a pgvector function — if it errors, the extension is missing.
// The md5 fingerprint is how we prove each row got its OWN vector, rather than
// one vector being written over every row by a mis-targeted UPDATE.
type ChunkRow = {
  chunkIndex: number;
  dims: number | null;
  fingerprint: string | null;
  content: string;
};

function readChunks(documentId: string) {
  return prisma.$queryRaw<ChunkRow[]>`
    SELECT "chunkIndex",
           vector_dims(embedding) AS dims,
           md5(embedding::text)   AS fingerprint,
           content
    FROM "Chunk"
    WHERE "documentId" = ${documentId}
    ORDER BY "chunkIndex" ASC
  `;
}

async function main() {
  console.log("\n🔥 Ingestion smoke test");
  console.log(
    FAKE
      ? "   mode: --fake (stub embeddings, OpenAI NOT called)\n"
      : "   mode: live (real OpenAI embeddings)\n",
  );

  const user = await prisma.user.upsert({
    where: { email: SMOKE_EMAIL },
    update: {},
    create: { email: SMOKE_EMAIL, password: "placeholder-not-a-valid-hash" },
  });
  console.log(`Using smoke user ${user.email} (${user.id})\n`);

  // Start from a clean slate. Ingestion is now idempotent per (user, content),
  // so documents left behind by an earlier `--keep` run would send Case 1 down
  // the dedupe path and fail a test that isn't actually broken. Deleting the
  // documents (not the user) cascades to their chunks.
  await prisma.document.deleteMany({ where: { userId: user.id } });

  // ---- Case 1: a real multi-chunk document -------------------------------
  console.log("Case 1 — multi-chunk document");
  const startedAt = Date.now();
  const result = await ingestDocument({
    userId: user.id,
    title: "RAG primer",
    content: SAMPLE_TEXT,
    ...(FAKE ? { embedFn: fakeEmbed } : {}),
  });
  const elapsed = Date.now() - startedAt;

  check("returns status READY", result.status === "READY", result.status);
  check("is not flagged as a duplicate", result.deduped === false);
  check(
    "split into more than one chunk",
    result.chunkCount > 1,
    `${result.chunkCount} chunks`,
  );

  const rows = await readChunks(result.id);
  check(
    "chunk rows persisted match returned count",
    rows.length === result.chunkCount,
    `${rows.length} rows in DB`,
  );

  // chunkIndex is the citation key — a gap or a duplicate would silently break
  // "answer cites chunk 3 of this document" later on.
  const indexesContiguous = rows.every((r, i) => r.chunkIndex === i);
  check("chunkIndex is contiguous from 0", indexesContiguous);

  const allEmbedded = rows.every((r) => r.dims === 1536);
  check(
    "every chunk has a 1536-dim embedding",
    allEmbedded,
    `dims: ${rows.map((r) => r.dims ?? "null").join(", ")}`,
  );

  // If the UPDATE matched the wrong rows, we'd see one fingerprint repeated.
  const fingerprints = new Set(rows.map((r) => r.fingerprint));
  check(
    "each chunk has a distinct embedding",
    fingerprints.size === rows.length,
    `${fingerprints.size} unique / ${rows.length}`,
  );

  // Guards against chunk/vector misalignment surviving a round-trip: the stored
  // text must still be a real excerpt of what we sent in.
  const firstStored = rows[0]?.content.slice(0, 60) ?? "";
  check(
    "stored content is a genuine excerpt of the source",
    firstStored.length > 0 && SAMPLE_TEXT.includes(firstStored),
  );

  const doc = await prisma.document.findUniqueOrThrow({
    where: { id: result.id },
  });
  check("document row status is READY", doc.status === "READY", doc.status);
  // The denormalised counter must agree with the rows actually written — if it
  // drifts, every document list in the UI lies.
  check(
    "document.chunkCount matches the chunk rows",
    doc.chunkCount === rows.length,
    `column: ${doc.chunkCount}, rows: ${rows.length}`,
  );
  check("document.error is null on success", doc.error === null);
  console.log(`  ⏱  ${elapsed}ms end to end\n`);

  // ---- Case 2: the empty-input branch ------------------------------------
  // Whitespace-only text produces zero chunks. The service treats that as a
  // valid outcome (READY, nothing to embed) rather than an error, so it must
  // not call OpenAI and must not leave the doc stuck in PROCESSING.
  console.log("Case 2 — whitespace-only document");
  const empty = await ingestDocument({
    userId: user.id,
    title: "empty",
    content: "   \n\n   ",
  });

  check("returns status READY", empty.status === "READY", empty.status);
  check("reports zero chunks", empty.chunkCount === 0);
  const emptyRows = await readChunks(empty.id);
  check("wrote no chunk rows", emptyRows.length === 0);
  console.log();

  // ---- Case 3: dedupe on identical content -------------------------------
  // @@unique([userId, contentHash]) plus the pre-check in the service make
  // ingestion idempotent per (user, content). The point isn't just "no duplicate
  // row" — it's that we don't pay OpenAI twice for text we've already embedded.
  // Passing an embedder that THROWS proves the embedding step was never reached:
  // if the dedupe path ever regresses, this case fails loudly instead of quietly
  // running up a bill. A different title with the same body still dedupes —
  // the hash covers content only.
  console.log("Case 3 — re-ingesting identical content");
  const dupe = await ingestDocument({
    userId: user.id,
    title: "RAG primer (re-uploaded)",
    content: SAMPLE_TEXT,
    embedFn: () => {
      throw new Error("embedder must not be called for already-ingested content");
    },
  });

  check("returns the existing document id", dupe.id === result.id, dupe.id);
  check("flags the result as deduped", dupe.deduped === true);
  check(
    "reports the original chunk count",
    dupe.chunkCount === result.chunkCount,
    `${dupe.chunkCount} vs ${result.chunkCount}`,
  );

  const afterDupe = await readChunks(result.id);
  check(
    "wrote no additional chunk rows",
    afterDupe.length === rows.length,
    `${afterDupe.length} rows`,
  );

  // Only Case 1 and Case 2 should have produced documents; Case 3 must not have
  // created a third.
  const docCount = await prisma.document.count({ where: { userId: user.id } });
  check("user still has exactly 2 documents", docCount === 2, `${docCount}`);
  console.log();

  // ---- Cleanup ------------------------------------------------------------
  // Deleting the user cascades to Document and then to Chunk (onDelete: Cascade
  // on both relations), so this doubles as a check that the FKs are wired up.
  if (KEEP) {
    console.log(`Kept smoke data — document id ${result.id}\n`);
  } else {
    await prisma.user.delete({ where: { id: user.id } });
    const leftover = await prisma.chunk.count({
      where: { documentId: { in: [result.id, empty.id] } },
    });
    check("cascade delete removed all chunks", leftover === 0);
    console.log();
  }

  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed.\n`);
  } else if (FAKE) {
    console.log(
      "✅ All checks passed — but with STUB embeddings.\n" +
        "   Chunking, the pgvector write, the transaction and the cascades are proven.\n" +
        "   The OpenAI call is NOT. Re-run without --fake to close that gap.\n",
    );
  } else {
    console.log("✅ All checks passed — the ingestion pipeline works end to end.\n");
  }
}

main()
  .catch((err) => {
    console.error("\n💥 Smoke test threw:\n", err);
    failures++;
  })
  // Always disconnect: the pg pool holds the event loop open, so without this
  // the script would finish its work and then just hang there.
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
