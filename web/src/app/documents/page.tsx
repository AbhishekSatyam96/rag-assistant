"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, isProcessing, listDocuments, type DocumentSummary } from "@/lib/api";
import { useRequireAuth } from "@/lib/use-require-auth";
import { DocumentForm } from "@/components/DocumentForm";
import { DocumentList } from "@/components/DocumentList";

const POLL_INTERVAL_MS = 1500;

export default function DocumentsPage() {
  const { user, token, status, logout } = useRequireAuth();

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

  if (status !== "authenticated" || !user || !token) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-sm text-black/50 dark:text-white/50">
            Paste text or upload a PDF to chunk and embed it for retrieval.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
          <span className="text-black/50 dark:text-white/50">{user.email}</span>
          <div className="flex gap-3">
            <Link href="/ask" className="underline underline-offset-4">
              Ask
            </Link>
            <Link href="/me" className="underline underline-offset-4">
              Account
            </Link>
            <button onClick={logout} className="underline underline-offset-4">
              Log out
            </button>
          </div>
        </div>
      </header>

      <section className="mb-10">
        <DocumentForm token={token} onCreated={handleCreated} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Your documents</h2>
          {hasProcessing && (
            <span className="text-xs text-black/50 dark:text-white/50">updating…</span>
          )}
        </div>
        <DocumentList documents={documents} loading={loading} error={loadError} />
      </section>
    </div>
  );
}
