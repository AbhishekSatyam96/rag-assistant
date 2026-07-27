import { prisma } from "./prisma.js";
import { embed } from "./embed.js";

// Vector search: question in, the most semantically similar chunks out.
//
// This is the single most security-sensitive file in the codebase, and it is
// worth understanding exactly why. Everywhere else, tenant isolation is enforced
// through Prisma's query builder, where `where: { userId }` is type-checked and
// the shape of the API makes the rule hard to forget. Here we drop to raw SQL,
// because Prisma cannot express `ORDER BY embedding <=> $1::vector` — it has no
// model of the pgvector operators at all. The moment we write SQL by hand, the
// compiler stops helping: a missing `d."userId" = ...` still compiles, still
// passes every type check, and quietly returns other people's documents.
//
// So the ownership predicate is written into the WHERE clause below and called
// out here on purpose. Read it before changing anything in this file.

const DEFAULT_K = 5;

// How hard HNSW searches before giving up. pgvector's default is 40; the index
// is approximate, and this is the recall/latency dial. 100 is a deliberate
// over-spend: at this corpus size the extra work is unmeasurable, and it buys
// noticeably better recall on the filtered searches described below.
const EF_SEARCH = 100;

// One retrieved chunk, carrying everything needed both to prompt the model and
// to render a citation. `documentTitle` is joined in rather than fetched later
// because the citation UI needs a human-readable label, and doing it here costs
// nothing — we are already joining Document to enforce ownership.
export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  // The source page, when the document had pages (a PDF). NULL for every
  // pasted-text document — and permanently so, not "not yet", which is why the
  // null branch in the citation UI is a real state rather than a placeholder.
  page: number | null;
  content: string;
  // Cosine DISTANCE, straight from `<=>`: 0 = identical direction, 1 =
  // orthogonal, 2 = opposite. Lower is better — the opposite of the intuition
  // most people bring to a "score", which is exactly why the field is named
  // `distance` and not `score`.
  distance: number;
  // The same number flipped into the "higher is better" form people expect, so
  // no caller has to remember to do `1 - x` (and get it wrong in a template).
  similarity: number;
};

type RetrieveInput = {
  userId: string;
  question: string;
  k?: number;
  // Same dependency-injection seam as ingestDocument's `embedFn`: tests can pass
  // a deterministic stub and exercise the SQL — including the tenant scoping —
  // without a paid OpenAI call.
  embedFn?: typeof embed;
};

// The row shape Postgres hands back. Declared separately from RetrievedChunk
// because `$queryRaw` is an unchecked cast: whatever we write here is what
// TypeScript believes, with nothing verifying it against the actual SELECT list.
// Keeping it adjacent to the query is the best available defence.
type ChunkRow = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  page: number | null;
  content: string;
  distance: number;
};

export async function retrieveChunks({
  userId,
  question,
  k = DEFAULT_K,
  embedFn = embed,
}: RetrieveInput): Promise<RetrievedChunk[]> {
  // A whitespace-only question would embed into a meaningless vector and return
  // the corpus's arbitrary "average" chunks — noise presented with the same
  // confidence as a real hit. Cheaper and more honest to return nothing.
  if (!question.trim()) return [];

  // The question goes through the SAME embedding model as the documents did.
  // This is not a detail: vectors from two different models live in unrelated
  // coordinate spaces, so cosine distance between them is a meaningless number
  // that still sorts, still looks plausible, and is entirely garbage. If
  // EMBED_MODEL in embed.ts ever changes, every stored embedding must be
  // recomputed — that is the real cost of switching models, not the code change.
  const [questionVector] = await embedFn([question]);

  // pgvector takes its input as the text form `[0.1,0.2,...]` and casts. Same
  // representation used on the write side in document.service.ts.
  const literal = `[${questionVector.join(",")}]`;

  // Why a transaction on a read path: `SET LOCAL` is scoped to the surrounding
  // transaction, and that scoping is the point. `SET` alone would mutate the
  // session, and with a connection pool that session is handed to the next
  // request — one query's tuning silently becomes global config. `SET LOCAL`
  // reverts on commit, so the settings can't leak across requests.
  const rows = await prisma.$transaction(async (tx) => {
    // `$executeRawUnsafe` deserves the flag its name carries, so: SET does not
    // accept bind parameters — `SET LOCAL x = $1` is a syntax error in Postgres,
    // because these are parsed as configuration, not as a query. String
    // interpolation is therefore the only option. It is safe here for one
    // specific reason: both interpolated values are module-level constants
    // defined above, never anything derived from a request. If either ever
    // becomes caller-controlled, this turns into SQL injection immediately.
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);

    // THE FILTERED-SEARCH RECALL PROBLEM, and the reason this line exists.
    //
    // An HNSW index knows only about vectors; it has no idea which rows belong
    // to which user. So Postgres walks the index in distance order and THEN
    // discards rows failing `d."userId" = ...` — post-filtering. Ask for the top
    // 5 and the scan may surface 40 candidates that all belong to other users,
    // leaving you with two results, or none. The query is still CORRECT (never
    // another tenant's data), but it silently under-returns, and it degrades as
    // more users join: the emptiest results land on the newest customers.
    //
    // pgvector 0.8 added iterative scans exactly for this: when the filter eats
    // the candidate set, keep scanning deeper instead of returning short.
    // `strict_order` guarantees results still arrive in true distance order
    // (`relaxed_order` is faster but can return them slightly out of order,
    // which would make our "top match" not actually the top match).
    //
    // The alternative design is denormalising `userId` onto Chunk and building
    // per-tenant partial indexes — genuinely faster at scale, but it multiplies
    // index count by tenant count and needs a backfill. Iterative scan is the
    // right trade until there is real traffic to argue otherwise.
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);

    return tx.$queryRaw<ChunkRow[]>`
      SELECT
        c.id             AS "chunkId",
        c."documentId"   AS "documentId",
        d.title          AS "documentTitle",
        c."chunkIndex"   AS "chunkIndex",
        c.page           AS "page",
        c.content        AS "content",
        (c.embedding <=> ${literal}::vector) AS "distance"
      FROM "Chunk" c
      JOIN "Document" d ON d.id = c."documentId"
      -- ⬇ THE TENANT SCOPE. Deleting this line breaks no test, produces no type
      -- error, and turns this endpoint into a full-corpus search across every
      -- user in the database. It is the whole reason this file has a comment
      -- block at the top.
      WHERE d."userId" = ${userId}
        -- A chunk written but not yet embedded (a crashed ingest, mid-flight
        -- work) has a NULL embedding, and NULL <=> vector is itself NULL, which
        -- sorts LAST under Postgres's default ORDER BY ... ASC NULLS LAST — so
        -- these rows would only surface once real matches ran out, which is
        -- precisely when a junk result does the most damage.
        --
        -- (Note for future edits: this SQL lives in a JS tagged template, so a
        -- backtick anywhere in these comments silently ends the string.)
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${literal}::vector
      LIMIT ${k}
    `;
  });

  return rows.map((row) => ({
    ...row,
    // Postgres returns `double precision`; the pg driver gives back a JS number.
    // Coerce anyway — a NUMERIC column would arrive as a string and every
    // downstream `.toFixed()` would throw at runtime instead of at compile time.
    distance: Number(row.distance),
    similarity: 1 - Number(row.distance),
  }));
}
