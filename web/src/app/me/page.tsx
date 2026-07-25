"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/use-require-auth";

// The protected page — the frontend mirror of the api's /me smoke test. Its
// content comes straight from the token the api validated.
export default function MePage() {
  const router = useRouter();
  // The redirect-if-unauthenticated guard used to live here as a local effect;
  // it moved into useRequireAuth so /documents shares it verbatim.
  const { user, status, logout } = useRequireAuth();

  if (status !== "authenticated" || !user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <p className="mb-1 text-sm text-black/50 dark:text-white/50">Signed in as</p>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight break-all">{user.email}</h1>

        <dl className="mb-8 rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          <dt className="mb-1 text-black/50 dark:text-white/50">User ID</dt>
          <dd className="font-mono break-all">{user.id}</dd>
        </dl>

        <div className="flex gap-3">
          <Link
            href="/documents"
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Documents
          </Link>
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
