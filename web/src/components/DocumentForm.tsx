"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  MAX_PDF_BYTES,
  createDocument,
  uploadPdf,
  type DocumentSummary,
} from "@/lib/api";

// Ingestion, both ways in: paste text, or upload a PDF.
//
// ONE COMPONENT, TWO MODES — rather than two sibling forms on the page. Both
// routes answer with the identical `{ document, deduped }` shape, so everything
// downstream (the `onCreated` callback, the parent's list merge, the polling
// loop) is shared; only the inputs and the request differ. Splitting them would
// mean duplicating the submit/error/notice machinery to save one `mode` flag.
//
// The component still owns only its inputs and submit state. The parent owns
// the document list, so it decides what a new document means for the UI.
// `onCreated` gets only the document: whether it was deduped is this
// component's business (it drives the notice and whether to clear the form),
// and the parent's merge behaves identically either way.
type DocumentFormProps = {
  token: string;
  onCreated: (document: DocumentSummary) => void;
};

type Mode = "paste" | "pdf";

// These mirror the api's zod schema (document.schema.ts) exactly. Kept in sync
// by hand — the server remains the source of truth, this only buys instant
// feedback so a 200k-character paste doesn't need a round-trip to be rejected.
const TITLE_MAX = 200;
const CONTENT_MAX = 200_000;

function validatePaste(title: string, content: string): string | null {
  // Trim before measuring, for the same reason the server does: "   " is three
  // characters but zero content.
  if (title.trim().length === 0) return "Give the document a title.";
  if (title.trim().length > TITLE_MAX) return `Title must be at most ${TITLE_MAX} characters.`;
  if (content.trim().length === 0) return "Paste some text to ingest.";
  if (content.trim().length > CONTENT_MAX)
    return `Content must be at most ${CONTENT_MAX.toLocaleString()} characters.`;
  return null;
}

// Note what is NOT validated here: the title, which is optional on this path —
// the api falls back to the filename. And the file's actual contents: whether
// those bytes are really a PDF is settled by the magic-byte check on the
// server, because a client-side check is trivially bypassed and therefore
// worth nothing as a guarantee. What this DOES buy is refusing a 40 MB file
// before spending a 40 MB upload on it.
function validatePdf(file: File | null): string | null {
  if (!file) return "Choose a PDF to upload.";
  if (file.size > MAX_PDF_BYTES) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_PDF_BYTES)}.`;
  }
  if (file.size === 0) return "That file is empty.";
  return null;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const INPUT_CLASS =
  "rounded-md border border-black/15 bg-transparent px-3 py-2 text-base outline-none " +
  "focus:border-black/40 dark:border-white/15 dark:focus:border-white/40";

export function DocumentForm({ token, onCreated }: DocumentFormProps) {
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A file input is one of the few genuinely uncontrolled inputs in React: its
  // displayed filename lives in the DOM, and setting `file` back to null does
  // not clear it. So we need the node itself to reset after a successful
  // upload, or the form keeps showing a file that is no longer staged.
  const fileInputRef = useRef<HTMLInputElement>(null);

  const contentLength = content.trim().length;
  const overLimit = contentLength > CONTENT_MAX;

  function switchMode(next: Mode) {
    setMode(next);
    // Clear feedback from the other mode — an error about a missing title makes
    // no sense once you've switched to uploading a file. The inputs themselves
    // are kept, so toggling back and forth doesn't lose a long paste.
    setError(null);
    setNotice(null);
  }

  function resetAfterCreate() {
    setTitle("");
    setContent("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const validationError =
      mode === "paste" ? validatePaste(title, content) : validatePdf(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const { document, deduped } =
        mode === "paste"
          ? await createDocument(token, { title, content })
          : // `file!` is safe: validatePdf returned null, which it only does
            // when a file is present.
            await uploadPdf(token, file!, title);

      onCreated(document);

      if (deduped) {
        // Naming the existing document matters more here than on the paste
        // path. Upload handbook-v2.pdf where only the diagrams changed and the
        // extracted text is identical, so it dedupes against v1 — a bare
        // "already ingested" leaves the user staring at a list that doesn't
        // contain the filename they just picked. Dedupe is on TEXT, not bytes,
        // and the message should make that visible rather than mysterious.
        setNotice(
          mode === "pdf"
            ? `That PDF's text is already in your library as “${document.title}”.`
            : "You've already ingested this exact text — showing the existing document.",
        );
      } else {
        // Only clear on a genuinely new document. On a dedupe the input is
        // still what the user is looking at, and wiping it would make it look
        // like the upload was lost.
        resetAfterCreate();
      }
    } catch (err) {
      // Prefer the first zod field message on a 400, else the server's `error`
      // string — which now also carries the upload-specific cases: 413 too
      // large, 422 scanned PDF with no selectable text, 400 corrupt or
      // password-protected.
      setError(
        err instanceof ApiError
          ? (err.details?.[0]?.message ?? err.message)
          : "Something went wrong. Please try again.",
      );
    } finally {
      // Unlike AuthForm, there's no navigation on success — this page stays put,
      // so the button must always be re-enabled.
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Ingestion method"
        className="flex w-fit rounded-md border border-black/10 p-0.5 text-sm dark:border-white/10"
      >
        <ModeTab active={mode === "paste"} onSelect={() => switchMode("paste")}>
          Paste text
        </ModeTab>
        <ModeTab active={mode === "pdf"} onSelect={() => switchMode("pdf")}>
          Upload PDF
        </ModeTab>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {/* Required for a paste, optional for a file — a file already has a
            name, and making someone retype it is friction with no purpose. */}
        {mode === "pdf" ? "Title (optional)" : "Title"}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            mode === "pdf" ? "Defaults to the filename" : "Q3 engineering handbook"
          }
          maxLength={TITLE_MAX}
          className={INPUT_CLASS}
        />
      </label>

      {mode === "paste" ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Text
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste the document text here…"
            rows={10}
            className={`${INPUT_CLASS} resize-y font-mono text-sm leading-relaxed`}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          PDF
          <input
            ref={fileInputRef}
            type="file"
            // A hint to the file picker, not a control: it filters the dialog
            // and nothing more. Anyone can pick "All files" past it, which is
            // exactly why the server checks the leading bytes.
            accept="application/pdf,.pdf"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
              setNotice(null);
            }}
            className={`${INPUT_CLASS} py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-black/8 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:bg-white/10`}
          />
        </label>
      )}

      <div className="flex items-center justify-between gap-4">
        <span
          className={
            overLimit && mode === "paste"
              ? "text-xs text-red-600 dark:text-red-400"
              : "text-xs text-black/50 dark:text-white/50"
          }
        >
          {mode === "paste"
            ? `${contentLength.toLocaleString()} / ${CONTENT_MAX.toLocaleString()} characters`
            : file
              ? `${file.name} · ${formatBytes(file.size)}`
              : `PDF, up to ${formatBytes(MAX_PDF_BYTES)}`}
        </span>

        <button
          type="submit"
          disabled={submitting || (mode === "paste" && overLimit)}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {/* Ingestion is synchronous today and chunk+embed takes a few seconds,
              so this label is doing real work — without it the page looks hung.
              The PDF path adds extraction on top, so it says what it's doing.
              No progress bar: fetch exposes no upload-progress event (that
              needs XMLHttpRequest), and at a 10 MB cap the upload is not the
              part of the wait worth reporting on. */}
          {submitting
            ? mode === "pdf"
              ? "Reading PDF…"
              : "Ingesting…"
            : mode === "pdf"
              ? "Upload PDF"
              : "Ingest document"}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-black/60 dark:text-white/60">{notice}</p>}
    </form>
  );
}

// `type="button"` is load-bearing: a <button> inside a <form> defaults to
// type="submit", so without it, switching tabs would submit the form.
function ModeTab({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`rounded px-3 py-1 transition-colors ${
        active
          ? "bg-black/8 font-medium dark:bg-white/10"
          : "text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
      }`}
    >
      {children}
    </button>
  );
}
