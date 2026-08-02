import { readFile } from "node:fs/promises";

import { extractPdf, looksLikePdf, hasNoText } from "../../src/lib/pdf.js";
import { chunkPages, chunkText } from "../../src/lib/chunk.js";
import {
  TEXT_SOURCES,
  PDF_SOURCES,
  manifestPath,
  docName,
  pdfPath,
  hashText,
  readSource,
  type Density,
  type Manifest,
} from "../sources.js";

// Reports what the corpus ACTUALLY becomes after parsing and chunking.
//
//   pnpm eval:inspect
//
// This runs before any metric is trusted, because a hit-rate of 0.4 has at least
// two completely different causes. Retrieval might genuinely be failing — or the
// corpus might have chunked into 300 fragments of forty characters each, in
// which case retrieval is working perfectly on inputs that were destroyed
// upstream. The numbers below tell those apart before a single embedding is paid
// for.
//
// It uses the app's OWN parser and splitter (lib/pdf.ts, lib/chunk.ts), not a
// reimplementation, so what it reports is exactly what ingestion would produce.
//
// Text is read live from the repo; PDFs come from corpus/. That asymmetry is the
// point of the drift check below — the PDFs are a build artifact and can fall
// behind the markdown they were rendered from.

function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

function fmt(label: string, q: ReturnType<typeof quantiles>) {
  return `${label} min ${String(q.min).padStart(5)} · p50 ${String(q.p50).padStart(5)} · p90 ${String(q.p90).padStart(5)} · max ${String(q.max).padStart(5)}`;
}

// The threshold below which a chunk is too vague to retrieve reliably. Not a
// tuned constant — a reporting aid, roughly a paragraph. A corpus where most
// chunks fall under it is the pathology chunk.ts warns about.
const TINY_CHUNK = 300;

async function readManifest(): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

// THE CHECK THAT REPLACED COPYING THE TEXT.
//
// Markdown is read live, PDFs are rendered artifacts. So the two halves can
// disagree: edit docs/concepts.md, skip the rebuild, and the eval ingests PDFs
// made from text that no longer exists — silently, with results that look
// entirely normal. Detecting that is strictly better than the old approach of
// freezing a copy, which hid the same drift in the other direction.
async function reportDrift(manifest: Manifest | null): Promise<boolean> {
  if (!manifest) {
    console.log("  ⚠️  No manifest — run `pnpm eval:corpus` first.\n");
    return true;
  }

  const stale: string[] = [];
  for (const entry of manifest.sources) {
    const current = hashText(await readSource(entry.path));
    if (current !== entry.sha256) stale.push(entry.path);
  }

  const commit = `${manifest.commit.slice(0, 7)}${manifest.dirty ? " (dirty)" : ""}`;
  console.log(`  built ${manifest.builtAt.slice(0, 19).replace("T", " ")} at commit ${commit}`);

  if (stale.length === 0) {
    console.log("  ✓ every source matches the manifest\n");
    return false;
  }

  console.log(
    `  ⚠️  ${stale.length} source(s) changed since the build:\n` +
      stale.map((p) => `       ${p}`).join("\n") +
      "\n     Text is read live, so it reflects the edits. The PDFs do NOT.\n" +
      "     Run `pnpm eval:corpus` before trusting any number below.\n",
  );
  return true;
}

async function main() {
  console.log("\n🔎 Corpus inspection\n");

  const manifest = await readManifest();
  await reportDrift(manifest);

  let totalChunks = 0;
  const perDensity: Record<string, number> = {};

  console.log("── Text sources (paste path, page = null, read in place) " + "─".repeat(15));
  for (const source of TEXT_SOURCES) {
    const raw = await readSource(source);
    const chunks = await chunkText(raw);
    totalChunks += chunks.length;
    const q = quantiles(chunks.map((c) => c.content.length));
    console.log(`\n  ${source}`);
    console.log(`    ${raw.length.toLocaleString()} chars → ${chunks.length} chunks`);
    console.log(`    ${fmt("chars/chunk:", q)}`);
  }

  console.log("\n── PDF sources (upload path, page-aware, built) " + "─".repeat(24));
  const densities = manifest?.densities ?? (["dense", "sparse"] as Density[]);

  for (const source of PDF_SOURCES) {
    for (const density of densities) {
      const path = pdfPath(source, density);
      const label = `${docName(source)}.${density}.pdf`;

      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        console.log(`\n  ${label}\n    ✗ not built — run \`pnpm eval:corpus\``);
        continue;
      }

      // The same two gates the upload route applies, so a corpus file the API
      // would reject fails here rather than halfway through an eval run.
      if (!looksLikePdf(buf)) {
        console.log(`\n  ${label}\n    ✗ magic bytes are not %PDF- — the upload route would 400 this`);
        continue;
      }

      const extracted = await extractPdf(buf);
      if (hasNoText(extracted)) {
        console.log(`\n  ${label}\n    ✗ no extractable text — the upload route would 422 this`);
        continue;
      }

      const pageLens = extracted.pages.map((p) => p.trim().length).filter((n) => n > 0);
      const chunks = await chunkPages(extracted.pages);
      totalChunks += chunks.length;
      perDensity[density] = (perDensity[density] ?? 0) + chunks.length;
      const chunkLens = chunks.map((c) => c.content.length);
      const tiny = chunkLens.filter((n) => n < TINY_CHUNK).length;

      console.log(`\n  ${label}`);
      console.log(
        `    ${extracted.pages.length} pages (${pageLens.length} non-blank) → ${chunks.length} chunks`,
      );
      console.log(`    ${fmt("chars/page: ", quantiles(pageLens))}`);
      console.log(`    ${fmt("chars/chunk:", quantiles(chunkLens))}`);
      console.log(
        `    chunks under ${TINY_CHUNK} chars: ${tiny}/${chunks.length}` +
          ` (${Math.round((100 * tiny) / chunks.length)}%)` +
          (tiny / chunks.length > 0.5 ? "   ← the page-boundary pathology" : ""),
      );
    }
  }

  // A single eval run uses ONE density, so the all-files total is not the size
  // of any corpus that actually gets ingested. Reporting both stops that number
  // being quoted as if it were.
  const textChunks = totalChunks - Object.values(perDensity).reduce((a, b) => a + b, 0);
  console.log(`\n  ${totalChunks} chunks across all files. A run uses one density:`);
  for (const [density, count] of Object.entries(perDensity)) {
    console.log(`    ${density.padEnd(7)} ${textChunks} text + ${count} pdf = ${textChunks + count} chunks`);
  }
  console.log();
}

main().catch((err) => {
  console.error("\n💥 Inspection failed:\n", err);
  process.exit(1);
});
