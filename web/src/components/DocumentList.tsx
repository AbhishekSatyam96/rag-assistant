"use client";

import { isProcessing, type DocStatus, type DocumentSummary } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/Card";
import { IconFile } from "@/components/icons";

// Every state the api's DocStatus machine can be in gets an explicit visual.
// Typing this as a full Record means adding a status to the enum server-side
// becomes a TypeScript error here, rather than a row that silently renders
// nothing.
const STATUS: Record<DocStatus, { label: string; tone: "neutral" | "warn" | "success" | "danger"; pulse?: boolean }> = {
  PENDING: { label: "Queued", tone: "warn", pulse: true },
  PROCESSING: { label: "Processing", tone: "warn", pulse: true },
  READY: { label: "Ready", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};

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
  // A skeleton here rather than the spinner used on page load, and the reason
  // is the inverse of PageLoading's: by this point we know a list is coming, so
  // reserving its shape stops the page reflowing when the rows land.
  if (loading) {
    return (
      <ul className="flex flex-col gap-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-19 animate-shimmer rounded-xl border border-line bg-surface"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </ul>
    );
  }

  if (error) return <Alert tone="error">{error}</Alert>;

  if (documents.length === 0) {
    return (
      <EmptyState icon={<IconFile />} title="No documents yet">
        Paste some text or drop in a PDF above — it gets chunked and embedded so you
        can ask about it.
      </EmptyState>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {documents.map((doc) => {
        const status = STATUS[doc.status];
        return (
          <li
            key={doc.id}
            className="rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors duration-150 hover:border-line-strong"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                  <IconFile className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium wrap-break-word text-fg">{doc.title}</h3>
                  <p className="mt-0.5 text-xs text-muted">
                    {/* chunkCount is denormalised onto Document server-side
                        precisely so this list doesn't need a COUNT(*) against
                        Chunk. */}
                    {doc.status === "READY"
                      ? `${doc.chunkCount} ${doc.chunkCount === 1 ? "chunk" : "chunks"}`
                      : isProcessing(doc)
                        ? "Chunking and embedding…"
                        : "Not indexed"}
                    <span className="mx-1.5 text-faint">·</span>
                    <span className="text-faint">{formatDate(doc.createdAt)}</span>
                  </p>
                </div>
              </div>

              <Badge tone={status.tone} dot pulse={status.pulse}>
                {status.label}
              </Badge>
            </div>

            {/* A FAILED document explains itself inline — this is why `error` is
                in the list select rather than detail-only. */}
            {doc.status === "FAILED" && doc.error && (
              <p className="mt-3 rounded-lg border border-danger/25 bg-danger-soft px-2.5 py-2 font-mono text-[11px] wrap-break-word text-danger">
                {doc.error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
