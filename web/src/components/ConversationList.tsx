"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, deleteConversation, type ConversationSummary } from "@/lib/api";
import { cn } from "@/lib/cn";
import { IconChat, IconTrash } from "@/components/icons";

// Recent threads. Rendered on /chat (the new-conversation page) rather than as a
// permanent sidebar: this app's shell is a single centred column at every width,
// and bolting a sidebar onto one route would make that route the odd one out.

type ConversationListProps = {
  token: string;
  conversations: ConversationSummary[];
  // Lifted to the parent because the parent owns the list — deleting has to
  // remove the row from the same array that renders it.
  onDeleted: (id: string) => void;
  activeId?: string;
};

export function ConversationList({
  token,
  conversations,
  onDeleted,
  activeId,
}: ConversationListProps) {
  return (
    <ul className="flex flex-col gap-1.5">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <ConversationRow
            token={token}
            conversation={conversation}
            onDeleted={onDeleted}
            active={conversation.id === activeId}
          />
        </li>
      ))}
    </ul>
  );
}

function ConversationRow({
  token,
  conversation,
  onDeleted,
  active,
}: {
  token: string;
  conversation: ConversationSummary;
  onDeleted: (id: string) => void;
  active: boolean;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    // A destructive action with no undo, so it asks first. Deliberately
    // `confirm()` rather than a custom modal: the app has no dialog primitive
    // yet, and inventing one here would be a component built for a single
    // caller. Naming the thread in the prompt is the part that matters — "Delete
    // this?" is how people delete the wrong one.
    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      await deleteConversation(token, conversation.id);
      onDeleted(conversation.id);
    } catch (err) {
      // Stay in the list on failure rather than optimistically removing the row
      // and putting it back. An optimistic delete that reverts is more alarming
      // than a slow one: the thread appears to be gone, then reappears, and the
      // user has no idea which state is real.
      setError(err instanceof ApiError ? err.message : "Couldn't delete that.");
      setDeleting(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-xl border bg-surface pr-1.5 shadow-sm transition-colors duration-150",
        active ? "border-accent" : "border-line hover:border-line-strong",
        deleting && "opacity-50",
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3.5 py-3"
      >
        <IconChat className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {conversation.title}
        </span>
        {/* `suppressHydrationWarning` because this formats in the visitor's
            locale and timezone. The server renders one string and the browser
            can render a different one for the same instant, which React reports
            as a hydration mismatch — a real warning about a non-problem. */}
        <time
          dateTime={conversation.updatedAt}
          suppressHydrationWarning
          className="shrink-0 text-[11px] text-faint tabular-nums"
        >
          {formatWhen(conversation.updatedAt)}
        </time>
      </Link>

      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        // Named for the thread, not "Delete" — a screen reader listing this page
        // would otherwise announce a column of identical buttons.
        aria-label={`Delete conversation: ${conversation.title}`}
        title={error ?? "Delete conversation"}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
          // Hidden until hover on a fine pointer, always visible on touch, and
          // always reachable by keyboard via focus-visible. `opacity` rather
          // than `hidden` so it never changes the row's layout.
          "text-faint opacity-100 hover:bg-raised hover:text-danger focus-visible:opacity-100",
          "sm:opacity-0 sm:group-hover:opacity-100",
          error && "text-danger opacity-100 sm:opacity-100",
        )}
      >
        <IconTrash className="size-3.5" />
      </button>
    </div>
  );
}

// Relative for the recent past, absolute once "3 days ago" stops being more
// useful than a date. The cutoff is a week because that is roughly where people
// switch from thinking in elapsed time to thinking in calendar time.
function formatWhen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`;

  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
