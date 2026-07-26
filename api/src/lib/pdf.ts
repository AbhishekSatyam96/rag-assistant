import { extractText } from "unpdf";
import { HttpError } from "./http-error";

// PDF → text. The parser layer the ingestion pipeline deliberately did not have
// until now (see the scope note at the top of document.service.ts): everything
// downstream still only understands text, and this is the single place that
// knows a PDF exists at all.
//
// WHY unpdf AND NOT pdf-parse
// unpdf is a prebuilt, ESM-native bundle of Mozilla's pdf.js — the same engine
// Firefox renders PDFs with. The popular alternative, `pdf-parse`, wraps a 2018
// fork of pdf.js and hands back one concatenated string, which would make the
// page-aware chunking below impossible. Using pdfjs-dist directly is the third
// option; it works, but its Node ESM build needs explicit worker configuration
// that buys us nothing here.
//
// The tradeoff worth stating out loud: pdf.js extracts text that is ALREADY in
// the file. A scanned document is a picture of text, and this returns empty
// pages for it. That is not a bug to fix here — it is OCR, an entirely separate
// (and much more expensive) capability. See `hasNoText` below for how the route
// turns that into an honest error instead of an empty document.

// RUNTIME SHIM — delete this when the API runs on Node 25+.
//
// pdf.js calls `Math.sumPrecise`, a TC39 proposal that is Stage 3 and not in
// Node 24's V8. Without it, every extraction logs `Warning: TypeError:
// Math.sumPrecise is not a function`. Text extraction still SUCCEEDS, because
// pdf.js catches it — the call sites are font-table construction and XFA form
// layout, neither of which getTextContent() needs. So this is not a
// correctness fix for our path; it removes a line of log noise per upload and
// closes a real gap on the paths we don't currently exercise.
//
// It uses Neumaier compensated summation rather than a plain `reduce`, because
// a shim that silently has different numerics from the thing it stands in for
// is worse than no shim: `c` accumulates the low-order bits lost at each step,
// so the result matches what the real implementation guarantees.
//
// Guarded, so it is a no-op the moment the runtime ships its own.
if (typeof (Math as { sumPrecise?: unknown }).sumPrecise !== "function") {
  (Math as unknown as { sumPrecise: (values: Iterable<number>) => number }).sumPrecise = (
    values,
  ) => {
    let sum = 0;
    let c = 0;
    for (const value of values) {
      const t = sum + value;
      c += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
      sum = t;
    }
    return sum + c;
  };
}

// Every PDF begins with the version header `%PDF-1.x`. Five bytes is enough to
// tell a real PDF from an HTML error page or a renamed zip.
const PDF_MAGIC = Buffer.from("%PDF-");

// A cheap ceiling checked BEFORE extraction, because page count is the thing
// that actually drives cost here: a 2 MB file can hold thousands of pages, so
// the byte limit multer enforces is not a bound on the work this function does.
const MAX_PAGES = 200;

export type ExtractedPdf = {
  // One entry per page, page N at index N-1. Kept as an ARRAY rather than a
  // joined string on purpose: the page boundary is information that only exists
  // at this moment, and joining here would throw away the one thing a PDF gives
  // us that a pasted string cannot — the ability to cite "page 7".
  pages: string[];
  pageCount: number;
};

// Is this actually a PDF?
//
// The important part: multer's `file.mimetype` is NOT an inspection of the
// file. It is copied from the Content-Type header the client wrote into that
// part of the multipart body, so it is a claim, and `curl -F
// "file=@evil.html;type=application/pdf"` makes that claim dishonestly. The
// bytes are the evidence.
//
// Necessary, not sufficient: this proves the file STARTS like a PDF, not that
// it is valid or benign. The real guarantee is that pdf.js either parses it or
// throws — plus the fact that we never store the upload or serve it back, which
// is what rules out the classic "upload HTML, get it served, stored XSS" path.
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

// pdf.js reports a password-protected file through an error whose `name` is
// "PasswordException". We match on that rather than on the message, which is
// prose and can change between versions.
function isPasswordProtected(err: unknown): boolean {
  return err instanceof Error && err.name === "PasswordException";
}

// pdf.js emits text positionally — it reconstructs a line from the glyph runs
// it finds, so what comes back is peppered with runs of spaces, stray single
// newlines mid-sentence, and occasional \r.
//
// This collapses that noise while PRESERVING blank lines, and that distinction
// is load-bearing: RecursiveCharacterTextSplitter tries paragraph boundaries
// ("\n\n") before it falls back to lines, then sentences, then words. Flatten
// every newline here and chunking silently degrades to word-level slicing, so
// chunks stop lining up with ideas. This is the least interesting-looking
// function in the file and the one with the biggest effect on answer quality.
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // 3+ newlines → exactly one paragraph break. Keeps \n\n meaningful.
    .replace(/\n{3,}/g, "\n\n")
    // Runs of spaces/tabs → one space, without touching newlines.
    .replace(/[^\S\n]+/g, " ")
    // Trailing/leading spaces that the rule above left sitting against newlines.
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

export async function extractPdf(buffer: Buffer): Promise<ExtractedPdf> {
  if (!looksLikePdf(buffer)) {
    throw new HttpError(400, "That file isn't a PDF.");
  }

  let result: { totalPages: number; text: string[] };
  try {
    // A fresh Uint8Array rather than handing over the Buffer directly. Two
    // reasons: multer's memory storage hands back a Buffer that can be a view
    // into a larger pooled ArrayBuffer, and pdf.js may take ownership of (and
    // detach) the buffer it is given. Copying costs one allocation and removes
    // both hazards.
    //
    // `mergePages: false` is the whole point — one string per page.
    result = await extractText(new Uint8Array(buffer), { mergePages: false });
  } catch (err) {
    if (isPasswordProtected(err)) {
      throw new HttpError(400, "This PDF is password-protected. Remove the password and try again.");
    }
    // Anything else out of the parser is a malformed file, not a server fault:
    // the bytes started with %PDF- but pdf.js could not make a document of
    // them. A 400 with the cause preserved for the logs.
    throw new HttpError(400, "Couldn't read this PDF — the file may be corrupt.", { cause: err });
  }

  if (result.totalPages > MAX_PAGES) {
    throw new HttpError(
      400,
      `This PDF has ${result.totalPages} pages. The limit is ${MAX_PAGES}.`,
    );
  }

  return {
    pages: result.text.map(normalizeWhitespace),
    pageCount: result.totalPages,
  };
}

// True when the PDF parsed fine but carries no extractable text — overwhelmingly
// a scan or an export-as-image. Separated from extractPdf so the ROUTE decides
// the HTTP response: extraction genuinely succeeded, and "there is nothing to
// index" is a semantic outcome (422), not a parse failure (400).
export function hasNoText({ pages }: ExtractedPdf): boolean {
  return pages.every((page) => page.trim().length === 0);
}
