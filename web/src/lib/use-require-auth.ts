"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-context";

// The client-side guard for protected pages, lifted out of /me so that
// /documents — and every protected page after it — doesn't copy-paste the same
// effect. Duplicating an auth guard is how one page eventually ends up missing
// it.
//
// Because a failed /me during rehydration resolves to "unauthenticated" in the
// context, an expired token bounces through this same path as "never logged in":
// one redirect covers both.
//
// Note this is a UX guard, not a security boundary. It hides UI; it doesn't
// protect data. Every /documents route on the api independently verifies the
// token, which is what actually keeps one user's documents away from another's.
export function useRequireAuth() {
  const router = useRouter();
  const auth = useAuth();

  useEffect(() => {
    if (auth.status === "unauthenticated") router.replace("/login");
  }, [auth.status, router]);

  return auth;
}
