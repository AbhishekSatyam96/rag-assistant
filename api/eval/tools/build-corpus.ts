import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { marked } from "marked";

import {
  TEXT_SOURCES,
  PDF_SOURCES,
  corpusDir,
  pdfDir,
  manifestPath,
  repoRoot,
  docName,
  pdfPath,
  hashText,
  readSource,
  type Density,
  type Manifest,
} from "../sources.js";

// Renders the PDF half of the eval corpus, and records what it was built from.
//
//   pnpm eval:corpus                  # both densities
//   pnpm eval:corpus --density=sparse # one
//
// NOTE WHAT THIS DOES NOT DO: it does not touch the text half. Markdown sources
// are read straight out of the repo at eval time — see the long note in
// eval/sources.ts for why copying them was a mistake. The only thing that has to
// be *built* is a PDF, because a PDF does not exist until something renders it.

const execFileAsync = promisify(execFile);

// PAGE DENSITY IS AN EXPERIMENTAL VARIABLE, NOT A STYLE CHOICE.
//
// chunkPages splits each page independently, which makes the page a hard chunk
// boundary — so page length becomes a second, invisible maximum on chunkSize
// (documented at length in lib/chunk.ts). Whether that matters depends entirely
// on how much text a page holds, which is exactly the kind of "it depends" the
// harness exists to replace with a number.
//
// So the same documents render at two densities. Running the full eval against
// each, with everything else held constant, isolates page density as the single
// changed variable — which is what turns "short pages are probably bad" into a
// measured hit-rate delta, and decides whether the deferred merge pass is worth
// a schema change.
const DENSITIES: Record<Density, { page: string; margin: string; fontSize: string; lineHeight: string }> = {
  // A page holds several chunks, so page boundaries rarely coincide with chunk
  // boundaries. The benign case.
  dense: { page: "A4", margin: "20mm", fontSize: "11pt", lineHeight: "1.45" },
  // Every page is smaller than chunkSize, so the splitter emits exactly one
  // undersized chunk per page however it is configured. The pathology, on
  // purpose.
  sparse: { page: "A5 landscape", margin: "18mm", fontSize: "17pt", lineHeight: "1.75" },
};

function chromePath(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No Chrome/Chromium found. Set CHROME_PATH to the browser binary.\n" +
        `Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}`,
    );
  }
  return found;
}

// Mermaid blocks are diagram SOURCE, not prose. Left in, they become several
// hundred characters of `flowchart TD / A --> B` per diagram — text that no
// question will ever ask about, that dilutes the embedding of whatever chunk it
// lands in, and that a real PDF export would have rendered as an image anyway.
function stripMermaid(markdown: string): string {
  return markdown.replace(/^```mermaid\n[\s\S]*?^```$/gm, "");
}

function htmlShell(body: string, density: Density): string {
  const d = DENSITIES[density];
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @page { size: ${d.page}; margin: ${d.margin}; }
  body {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: ${d.fontSize};
    line-height: ${d.lineHeight};
    color: #000;
  }
  /* Keep a heading attached to the text under it. Without this, a page can end
     on a lone heading, producing a page whose entire extracted text is four
     words — a chunk that is pure noise and would show up in the results as a
     retrieval failure that is really a rendering artefact. */
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-size: 0.85em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  img { max-width: 100%; }
</style></head>
<body>${body}</body></html>`;
}

async function renderPdf(markdown: string, outPath: string, density: Density) {
  const html = htmlShell(await marked.parse(stripMermaid(markdown)), density);

  // Chrome only prints from a file:// URL, so the HTML has to land on disk.
  const tmpHtml = `${outPath}.html`;
  await writeFile(tmpHtml, html, "utf8");

  try {
    await execFileAsync(chromePath(), [
      "--headless=new",
      "--disable-gpu",
      // Without this, Chrome stamps the file:// URL and today's date into the
      // margin of EVERY page. That text is extracted by the PDF parser like any
      // other, so it would appear in every single chunk — a constant string
      // repeated corpus-wide, which is about the worst thing that can happen to
      // an embedding space.
      "--no-pdf-header-footer",
      `--print-to-pdf=${outPath}`,
      `file://${tmpHtml}`,
    ]);
  } finally {
    await rm(tmpHtml, { force: true });
  }
}

// Provenance, which is what the discarded copy-the-text approach was reaching
// for and getting wrong. A commit SHA plus per-source hashes reproduces a run
// exactly, costs a few hundred bytes, and — unlike a copy — cannot go stale
// without saying so.
async function gitProvenance(): Promise<{ commit: string; dirty: boolean }> {
  try {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
    });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
    });
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    // Not a git checkout, or git is unavailable. Not fatal — the per-source
    // hashes below still pin the inputs.
    return { commit: "unknown", dirty: false };
  }
}

async function main() {
  const only = process.argv
    .find((a) => a.startsWith("--density="))
    ?.slice("--density=".length) as Density | undefined;

  if (only && !(only in DENSITIES)) {
    throw new Error(`Unknown density "${only}". Expected: ${Object.keys(DENSITIES).join(", ")}`);
  }

  const densities = only ? [only] : (Object.keys(DENSITIES) as Density[]);

  await mkdir(pdfDir, { recursive: true });

  console.log("\n📚 Building eval corpus (PDF half only — text is read in place)\n");

  const sources: Manifest["sources"] = [];

  // Text sources are hashed, not copied. The hash is what lets the inspector and
  // the eval runner detect that a doc changed after the PDFs were rendered.
  for (const source of TEXT_SOURCES) {
    const raw = await readSource(source);
    sources.push({ path: source, kind: "text", sha256: hashText(raw), chars: raw.length });
    console.log(
      `  text   ${docName(source).padEnd(10)} ${raw.length.toLocaleString().padStart(8)} chars  (read in place)`,
    );
  }

  for (const source of PDF_SOURCES) {
    const raw = await readSource(source);
    sources.push({ path: source, kind: "pdf", sha256: hashText(raw), chars: raw.length });

    for (const density of densities) {
      await renderPdf(raw, pdfPath(source, density), density);
      console.log(`  pdf    ${docName(source).padEnd(10)} ${density}`);
    }
  }

  const { commit, dirty } = await gitProvenance();
  const manifest: Manifest = {
    builtAt: new Date().toISOString(),
    commit,
    dirty,
    densities,
    sources,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    `\n✅ ${PDF_SOURCES.length} sources × ${densities.length} density/densities rendered` +
      `\n   commit ${commit.slice(0, 7)}${dirty ? " (tree dirty)" : ""}` +
      `\n   ${corpusDir}\n`,
  );
}

main().catch((err) => {
  console.error("\n💥 Corpus build failed:\n", err);
  process.exit(1);
});
