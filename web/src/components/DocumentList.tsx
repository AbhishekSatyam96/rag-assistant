"use client";

import { isProcessing, type DocStatus, type DocumentSummary } from "@/lib/api";

// Every state the api's DocStatus machine can be in gets an explicit visual.
// Typing this as a full Record means adding a status to the enum server-side
// becomes a TypeScript error here, rather than a row that silently renders
// nothing.
const STATUS_STYLE: Record<DocStatus, { label: string; className: string }> = {
  PENDING: {
    label: "Queued",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  PROCESSING: {
    label: "Processing",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  READY: {
    label: "Ready",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

function StatusBadge({ status }: { status: DocStatus }) {
  const { label, className } = STATUS_STYLE[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {(status === "PENDING" || status === "PROCESSING") && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      )}
      {label}
    </span>
  );
}

// `createdAt` arrives as an ISO string (JSON has no date type). This renders
// only after a client-side fetch, so there's no server/client formatting
// mismatch to worry about.
function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type DocumentListProps = {
  documents: DocumentSummary[];
  loading: boolean;
  error: string | null;
};

export function DocumentList({ documents, loading, error }: DocumentListProps) {
  if (loading) {
    return <p className="text-sm text-black/50 dark:text-white/50">Loading documents…</p>;
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-black/15 p-8 text-center dark:border-white/15">
        <p className="text-sm text-black/60 dark:text-white/60">
          No documents yet. Paste some text above to ingest your first one.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="rounded-md border border-black/10 p-4 dark:border-white/10"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-medium break-words">{doc.title}</h3>
            <StatusBadge status={doc.status} />
          </div>

          <p className="mt-1.5 text-xs text-black/50 dark:text-white/50">
            {/* chunkCount is denormalised onto Document server-side precisely so
                this list doesn't need a COUNT(*) against Chunk. */}
            {doc.status === "READY"
              ? `${doc.chunkCount} ${doc.chunkCount === 1 ? "chunk" : "chunks"}`
              : isProcessing(doc)
                ? "Chunking and embedding…"
                : "Not indexed"}
            {" · "}
            {formatDate(doc.createdAt)}
          </p>

          {/* A FAILED document explains itself inline — this is why `error` is in
              the list select rather than detail-only. */}
          {doc.status === "FAILED" && doc.error && (
            <p className="mt-2 rounded bg-red-500/5 px-2 py-1.5 font-mono text-xs break-words text-red-700 dark:text-red-400">
              {doc.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
