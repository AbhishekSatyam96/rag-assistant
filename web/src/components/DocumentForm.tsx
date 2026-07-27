"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  MAX_PDF_BYTES,
  createDocument,
  uploadPdf,
  type DocumentSummary,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea, CONTROL_CLASS } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { IconFile, IconUpload } from "@/components/icons";

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

const MODE_OPTIONS = [
  { value: "paste" as const, label: "Paste text", icon: <IconFile className="size-3.5" /> },
  { value: "pdf" as const, label: "Upload PDF", icon: <IconUpload className="size-3.5" /> },
];

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

export function DocumentForm({ token, onCreated }: DocumentFormProps) {
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
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

  function stageFile(next: File | null) {
    setFile(next);
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
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm"
    >
      <SegmentedControl
        label="Ingestion method"
        options={MODE_OPTIONS}
        value={mode}
        onChange={switchMode}
        className="self-start"
      />

      <Field
        // Required for a paste, optional for a file — a file already has a
        // name, and making someone retype it is friction with no purpose.
        label="Title"
        aside={mode === "pdf" ? "optional" : undefined}
      >
        {(field) => (
          <Input
            {...field}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              mode === "pdf" ? "Defaults to the filename" : "Q3 engineering handbook"
            }
            maxLength={TITLE_MAX}
          />
        )}
      </Field>

      {mode === "paste" ? (
        <Field
          label="Text"
          aside={`${contentLength.toLocaleString()} / ${CONTENT_MAX.toLocaleString()}`}
          error={overLimit ? "That's past the limit — trim it or split it up." : null}
        >
          {(field) => (
            <Textarea
              {...field}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste the document text here…"
              rows={9}
              className="font-mono text-[13px]"
            />
          )}
        </Field>
      ) : (
        <Field label="PDF" aside={`up to ${formatBytes(MAX_PDF_BYTES)}`}>
          {(field) => (
            // A drop zone wrapping a real <input type="file">, rather than a
            // styled input. The native control can't be restyled meaningfully
            // across browsers, but it CAN be stretched invisibly over a box we
            // draw ourselves — which keeps the keyboard behaviour, the file
            // picker and the form semantics entirely native while looking like
            // the rest of the app.
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (!dropped) return;
                stageFile(dropped);
                // Mirror the drop into the real input so the DOM's idea of the
                // staged file matches ours — otherwise resetAfterCreate has
                // nothing to clear, and the browser's own form state disagrees
                // with React's.
                if (fileInputRef.current) fileInputRef.current.files = e.dataTransfer.files;
              }}
              className={cn(
                CONTROL_CLASS,
                "relative flex min-h-30 cursor-pointer flex-col items-center justify-center gap-1 border-dashed px-4 py-6 text-center",
                dragging && "border-accent bg-accent-soft/40",
              )}
            >
              <input
                {...field}
                ref={fileInputRef}
                type="file"
                // A hint to the file picker, not a control: it filters the
                // dialog and nothing more. Anyone can pick "All files" past it,
                // which is exactly why the server checks the leading bytes.
                accept="application/pdf,.pdf"
                onChange={(e) => stageFile(e.target.files?.[0] ?? null)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
              <IconUpload className="size-5 text-faint" />
              {file ? (
                <>
                  <span className="max-w-full truncate text-sm font-medium text-fg">
                    {file.name}
                  </span>
                  <span className="text-xs text-muted">
                    {formatBytes(file.size)} · click to replace
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm text-fg">
                    Drop a PDF here, or click to browse
                  </span>
                  <span className="text-xs text-muted">
                    Pages are preserved, so citations can say “page 7”.
                  </span>
                </>
              )}
            </div>
          )}
        </Field>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      <div className="flex items-center justify-end gap-3">
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={mode === "paste" && overLimit}
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
        </Button>
      </div>
    </form>
  );
}
