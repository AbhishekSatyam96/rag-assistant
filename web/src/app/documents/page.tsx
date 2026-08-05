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
import { Alert } from "@/components/ui/Alert";
import { Button, ButtonLink } from "@/components/ui/Button";
import { IconSearch } from "@/components/icons";

const POLL_INTERVAL_MS = 1500;

// Polling refreshes the FIRST page only, but the user may have loaded several.
// A naive `setDocuments(fresh)` would silently discard every page after the
// first the moment a poll landed — the list would visibly collapse back to 20
// rows while the user was reading row 45.
//
// So merge by id instead: a fresh row replaces its counterpart IN PLACE (which
// is what makes a status flip to READY show up), genuinely new documents go on
// top, and anything the poll didn't cover — pages 2+ — is left untouched.
function mergeFirstPage(
  prev: DocumentSummary[],
  fresh: DocumentSummary[],
): DocumentSummary[] {
  const freshById = new Map(fresh.map((doc) => [doc.id, doc]));
  const known = new Set(prev.map((doc) => doc.id));

  return [
    // Newest-first ordering means anything genuinely new belongs at the head.
    ...fresh.filter((doc) => !known.has(doc.id)),
    ...prev.map((doc) => freshById.get(doc.id) ?? doc),
  ];
}

export default function DocumentsPage() {
  // `logout` is no longer destructured here — it moved into the shell's user
  // menu, along with the per-page nav links this header used to carry.
  const { user, token, status } = useRequireAuth();

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The cursor for the NEXT page, straight from the last response. Null means
  // there is no next page — the api sends no total, so this is the only signal
  // that the list is complete, and it's also what decides whether the "Load
  // more" control renders at all.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

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
        const page = await listDocuments(authToken);
        if (cancelled) return;
        setDocuments(page.documents);
        setNextCursor(page.nextCursor);
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
  //
  // It polls only the FIRST page, deliberately. Re-fetching every loaded page on
  // a 1.5s timer would multiply the request rate by however far the user has
  // scrolled, and a PROCESSING document is by definition recent — so it is on
  // page one. `mergeFirstPage` is what keeps the deeper pages intact.
  useEffect(() => {
    if (!token || !hasProcessing) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const page = await listDocuments(token);
        // NOTE: `nextCursor` is deliberately NOT updated here. It describes the
        // end of what this client has loaded, and a first-page poll knows
        // nothing about that — overwriting it would reset pagination to "there
        // is one more page" every tick.
        if (!cancelled) setDocuments((prev) => mergeFirstPage(prev, page.documents));
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

  const handleLoadMore = useCallback(async () => {
    // `loadingMore` guards against a double-click firing two requests with the
    // same cursor and appending the same page twice.
    if (!token || !nextCursor || loadingMore) return;

    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listDocuments(token, { cursor: nextCursor });
      setDocuments((prev) => {
        // Append, filtering ids already held. Cursor pagination means an insert
        // at the head can't shift a boundary further down, so an overlap
        // shouldn't happen — but a list that renders the same document twice is
        // a much worse failure than one redundant Set, and React would also
        // warn about the duplicate key.
        const known = new Set(prev.map((doc) => doc.id));
        return [...prev, ...page.documents.filter((doc) => !known.has(doc.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      // Unlike a failed poll, this IS surfaced: the user pressed a button, so
      // silence would read as the button being broken. The already-loaded rows
      // stay on screen and the cursor is untouched, so pressing it again retries.
      setMoreError(
        err instanceof ApiError ? err.message : "Couldn't load more documents.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [token, nextCursor, loadingMore]);

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
              // "total" would be a lie the moment the list is paginated — the
              // api sends no count, so all this number can honestly claim is how
              // many rows are currently on screen.
              <span className="text-xs text-faint tabular-nums">
                {documents.length} {nextCursor ? "loaded" : "total"}
              </span>
            ) : undefined
          }
        >
          Your documents
        </SectionHeading>
        <DocumentList documents={documents} loading={loading} error={loadError} />

        {/* Only rendered when the api says there IS more — never as a disabled
            button on the last page, which would invite a click that can't do
            anything. */}
        {nextCursor && !loading ? (
          <div className="mt-4 flex flex-col items-center gap-3">
            {moreError ? <Alert tone="error">{moreError}</Alert> : null}
            <Button size="sm" loading={loadingMore} onClick={handleLoadMore}>
              Load more
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
