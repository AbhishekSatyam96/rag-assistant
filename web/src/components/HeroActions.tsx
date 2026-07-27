"use client";

import { useAuth } from "@/lib/auth-context";
import { ButtonLink } from "@/components/ui/Button";
import { IconArrowRight } from "@/components/icons";

// The only interactive part of the landing page, split out so the rest of it
// stays a Server Component.
//
// Auth lives in localStorage, so "are you signed in" is unknowable until the
// client has hydrated and re-validated against /me. Rather than flicker between
// two different CTAs, the layout is identical in all three states and only the
// label and destination change — the buttons occupy the same space from first
// paint, so nothing shifts under the cursor.
export function HeroActions() {
  const { status } = useAuth();
  const authed = status === "authenticated";

  return (
    <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
      <ButtonLink
        href={authed ? "/ask" : "/signup"}
        variant="primary"
        size="lg"
        className="w-full sm:w-auto"
      >
        {authed ? "Open the assistant" : "Start asking"}
        <IconArrowRight className="size-4" />
      </ButtonLink>

      <ButtonLink
        href={authed ? "/documents" : "/login"}
        variant="secondary"
        size="lg"
        className="w-full sm:w-auto"
      >
        {authed ? "Your documents" : "Sign in"}
      </ButtonLink>
    </div>
  );
}
