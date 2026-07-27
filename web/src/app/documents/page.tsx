"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, isProcessing, listDocuments, type DocumentSummary } from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { DocumentForm } from "@/components/DocumentForm";
import { DocumentList } from "@/components/DocumentList";
import { PageHeader } from "@/components/AppShell";
import { PageLoading } from "@/components/ui/PageLoading";
import { SectionHeading } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { ButtonLink } from "@/components/ui/Button";
import { IconSearch } from "@/components/icons";

const POLL_INTERVAL_MS = 1500;

export default function DocumentsPage() {
  // `logout` is no longer destructured here — it moved into the shell's user
  // menu, along with the per-page nav links this header used to carry.
  const { user, token, status } = useRequireAuth();

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial load. Keyed on `token` rather than running once, because on a fresh
  // page load the token starts null and arrives after the context has finished
  // re-validating it against /me.
  useEffect(() => {
    if (!token) return;
    // Captured so the `!token` guard above survives into the async function
    // below: TypeScript discards narrowing inside a hoisted function
    // declaration, because it can't prove when the body actually runs.
    const authToken = token;
    let cancelled = false;

    async function load() {
      try {
        const { documents } = await listDocuments(authToken);
        if (cancelled) return;
        setDocuments(documents);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError ? err.message : "Couldn't load your documents.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const hasProcessing = documents.some(isProcessing);

  // Poll ONLY while something is mid-flight, and stop the moment everything is
  // terminal — `hasProcessing` is in the dependency array, so when it flips to
  // false the effect tears down and clears the interval. No polling on an idle
  // page.
  //
  // Today ingestion is synchronous, so documents arrive already READY and this
  // effect never runs. That's the point: the day the api starts answering 202
  // with PENDING, this begins working with no changes here.
  //
  // It polls the LIST rather than each document: one request per tick no matter
  // how many are processing, and it also picks up documents ingested in another
  // tab.
  useEffect(() => {
    if (!token || !hasProcessing) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const { documents } = await listDocuments(token);
        if (!cancelled) setDocuments(documents);
      } catch {
        // A failed poll is not worth surfacing — the last known state is still
        // on screen and the next tick will retry. Only the initial load sets
        // loadError, because there we have nothing to show.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, hasProcessing]);

  // Replace-and-move-to-front, so a deduped document (which already exists in
  // the list) doesn't appear twice. This works precisely because POST and GET
  // return the same shape — the new document is interchangeable with a listed one.
  const handleCreated = useCallback((document: DocumentSummary) => {
    setDocuments((prev) => [document, ...prev.filter((d) => d.id !== document.id)]);
  }, []);

  if (status !== "authenticated" || !user || !token) return <PageLoading />;

  const readyCount = documents.filter((d) => d.status === "READY").length;

  return (
    // `animate-rise` matches /ask and /me: every route in the app enters the
    // same way, so navigation reads as one product rather than three pages.
    <div className="mx-auto w-full max-w-2xl flex-1 animate-rise px-4 py-10 sm:px-6">
      <PageHeader
        back={{ href: "/", label: "Home" }}
        title="Documents"
        description="Paste text or upload a PDF to chunk and embed it for retrieval."
        actions={
          // Only offered once there's something to ask ABOUT. Sending someone
          // to /ask with an empty library guarantees a refusal, and a first
          // impression of "it doesn't work" is expensive to undo.
          readyCount > 0 ? (
            <ButtonLink href="/ask" variant="primary" size="sm">
              <IconSearch className="size-4" />
              Ask
            </ButtonLink>
          ) : undefined
        }
      />

      <section className="mb-10">
        <DocumentForm token={token} onCreated={handleCreated} />
      </section>

      <section>
        <SectionHeading
          aside={
            hasProcessing ? (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Spinner className="size-3" />
                updating
              </span>
            ) : documents.length > 0 ? (
              <span className="text-xs text-faint tabular-nums">
                {documents.length} total
              </span>
            ) : undefined
          }
        >
          Your documents
        </SectionHeading>
        <DocumentList documents={documents} loading={loading} error={loadError} />
      </section>
    </div>
  );
}
