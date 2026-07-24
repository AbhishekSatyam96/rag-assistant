"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

// The protected page — the frontend mirror of the api's /me smoke test. Its
// content comes straight from the token the api validated.
export default function MePage() {
  const router = useRouter();
  const { user, status, logout } = useAuth();

  // Client-side guard: any non-authenticated state bounces to /login. Because a
  // 401 on load (e.g. an expired token) resolves to "unauthenticated" in the
  // context, token expiry is covered by this same redirect.
  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

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
  );
}
