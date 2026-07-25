"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createDocument, type DocumentSummary } from "@/lib/api";

// Paste-text ingestion. File upload is deliberately not here yet: the api takes
// already-extracted plain text, and turning a PDF into text is a separate
// concern (a parser) that belongs upstream on the server.
//
// The component owns only its inputs and submit state. The parent owns the
// document list, so it decides what a new document means for the UI.
// `onCreated` gets only the document: whether it was deduped is this
// component's business (it drives the notice and whether to clear the form),
// and the parent's merge behaves identically either way.
type DocumentFormProps = {
  token: string;
  onCreated: (document: DocumentSummary) => void;
};

// These mirror the api's zod schema (document.schema.ts) exactly. Kept in sync
// by hand — the server remains the source of truth, this only buys instant
// feedback so a 200k-character paste doesn't need a round-trip to be rejected.
const TITLE_MAX = 200;
const CONTENT_MAX = 200_000;

function validate(title: string, content: string): string | null {
  // Trim before measuring, for the same reason the server does: "   " is three
  // characters but zero content.
  if (title.trim().length === 0) return "Give the document a title.";
  if (title.trim().length > TITLE_MAX) return `Title must be at most ${TITLE_MAX} characters.`;
  if (content.trim().length === 0) return "Paste some text to ingest.";
  if (content.trim().length > CONTENT_MAX)
    return `Content must be at most ${CONTENT_MAX.toLocaleString()} characters.`;
  return null;
}

const INPUT_CLASS =
  "rounded-md border border-black/15 bg-transparent px-3 py-2 text-base outline-none " +
  "focus:border-black/40 dark:border-white/15 dark:focus:border-white/40";

export function DocumentForm({ token, onCreated }: DocumentFormProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const contentLength = content.trim().length;
  const overLimit = contentLength > CONTENT_MAX;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const validationError = validate(title, content);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const { document, deduped } = await createDocument(token, { title, content });
      onCreated(document);

      // Only clear the form on a genuinely new document. On a dedupe the text is
      // still what the user is looking at, and wiping it would make it look like
      // the paste was lost.
      if (deduped) {
        setNotice("You've already ingested this exact text — showing the existing document.");
      } else {
        setTitle("");
        setContent("");
      }
    } catch (err) {
      // Prefer the first zod field message on a 400, else the server's `error`
      // string (e.g. the 413 for an oversized body).
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
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Q3 engineering handbook"
          maxLength={TITLE_MAX}
          className={INPUT_CLASS}
        />
      </label>

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

      <div className="flex items-center justify-between gap-4">
        <span
          className={
            overLimit
              ? "text-xs text-red-600 dark:text-red-400"
              : "text-xs text-black/50 dark:text-white/50"
          }
        >
          {contentLength.toLocaleString()} / {CONTENT_MAX.toLocaleString()} characters
        </span>

        <button
          type="submit"
          disabled={submitting || overLimit}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {/* Ingestion is synchronous today and chunk+embed takes a few seconds,
              so this label is doing real work — without it the page looks hung. */}
          {submitting ? "Ingesting…" : "Ingest document"}
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
