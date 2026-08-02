import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// WHICH DOCUMENTS ARE THE CORPUS — declared once, imported by the builder, the
// inspector, and the eval runner.
//
// WHY THE CORPUS IS OUR OWN WRITING, AND NOT A PUBLIC DATASET
//
// Pretraining contamination is the silent killer of a RAG eval. If the model
// already knows the answer, it produces a correct-looking response whether
// retrieval worked or not — so hit-rate, groundedness and refusal accuracy all
// stop measuring the system and start measuring the model's memory. A hit-rate
// of zero can still yield a "right" answer, which is the most misleading result
// the harness could possibly report. Text written for this repo cannot be in
// any training set, which makes contamination structurally impossible rather
// than merely unlikely.
//
// WHY THE TEXT AND PDF HALVES USE DIFFERENT DOCUMENTS
//
// The obvious move — render the same docs to PDF and ingest both — puts
// near-identical passages in the corpus twice. Retrieval then returns two copies
// of the same content, and a "hit" stops distinguishing "found the right
// passage" from "found one of its two duplicates". Partitioning by document
// keeps every passage in exactly one place.
//
// WHY TEXT SOURCES ARE READ IN PLACE AND NEVER COPIED INTO corpus/
//
// An earlier version copied them, on the reasoning that a snapshot makes a run
// reproducible. That reasoning was wrong, and the correction is worth keeping:
//
//   - corpus/ is gitignored, so a copy there is not a snapshot of anything. Git
//     is already the snapshot mechanism; reproducibility comes from recording
//     the commit a run was made at, which the manifest does.
//   - A copy inverts the very failure it was meant to prevent. Edit a doc,
//     forget to rebuild, and the eval scores text that no longer exists in the
//     repo — silently, and with results that look perfectly normal.
//   - It defeats fixture validation. The golden set's anchors must be checked
//     against the text that will actually be ingested. Validating against a
//     stale copy passes while the live corpus has drifted underneath it.
//
// PDFs are different: they cannot be read in place because they do not exist
// until they are rendered. They are genuine build artifacts, so they live in
// corpus/ with a manifest recording exactly what they were built from.

const here = dirname(fileURLToPath(import.meta.url));
export const evalDir = resolve(here);
export const repoRoot = resolve(evalDir, "..", "..");
export const corpusDir = join(evalDir, "corpus");
export const pdfDir = join(corpusDir, "pdf");
export const manifestPath = join(corpusDir, "manifest.json");

// Ingested through the PASTE path (POST /documents), so every chunk has
// `page: null`. Read directly from the repo at eval time.
export const TEXT_SOURCES = ["docs/hld.md", "docs/lld.md", "README.md"] as const;

// Ingested through the UPLOAD path (POST /documents/upload), so chunking is
// page-aware and citations carry a page number. Rendered into corpus/pdf/.
// Deliberately DISJOINT from TEXT_SOURCES.
export const PDF_SOURCES = ["docs/concepts.md", "docs/flows.md"] as const;

export type Density = "dense" | "sparse";

export function docName(source: string): string {
  return source.replace(/^docs\//, "").replace(/\.md$/, "");
}

export function pdfPath(source: string, density: Density): string {
  return join(pdfDir, `${docName(source)}.${density}.pdf`);
}

// The same hash the ingestion pipeline uses for dedupe (plain sha256, no salt —
// see document.service.ts). Here it serves the drift check: if a source doc's
// hash no longer matches what the manifest recorded, the rendered PDFs were
// built from different text than the markdown about to be ingested.
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function readSource(source: string): Promise<string> {
  return readFile(join(repoRoot, source), "utf8");
}

export type Manifest = {
  builtAt: string;
  // The commit the PDFs were rendered at, and whether the tree was dirty. This
  // is what makes a run reproducible — not a copy of the input.
  commit: string;
  dirty: boolean;
  densities: Density[];
  // Every corpus document, text and PDF-source alike, with the hash of the text
  // as it stood at build time.
  sources: { path: string; kind: "text" | "pdf"; sha256: string; chars: number }[];
};
