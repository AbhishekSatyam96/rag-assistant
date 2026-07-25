"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api";

// Login and signup are visually identical; a single form driven by `mode` keeps
// them in sync. The parent passes `onSubmit` (which calls the auth context and
// redirects) — this component only owns local input state, validation, and the
// loading / error UI.
type AuthFormProps = {
  mode: "login" | "signup";
  onSubmit: (email: string, password: string, inviteCode?: string) => Promise<void>;
};

// Whether this deployment is running invite-only. It mirrors SIGNUP_INVITE_CODE
// being set on the api, and yes — that is two variables that can disagree.
//
// The alternative (an endpoint the form calls to ask whether signup is open)
// costs a round-trip on every page load to save a config line, and the failure
// mode here is mild in both directions: set on the web but not the api and the
// field is ignored; set on the api but not here and the user gets the api's
// "Sign-ups are invite-only right now." — the correct message, just without a
// box to type into. Neither state loses data or grants access it shouldn't.
//
// Read as a full static reference, not a computed key: Next.js inlines
// NEXT_PUBLIC_* at build time by literal substitution, so a dynamic lookup
// (process.env[name]) silently yields undefined in the browser.
const INVITE_REQUIRED = process.env.NEXT_PUBLIC_SIGNUP_INVITE_REQUIRED === "true";

// Client-side validation mirrors the server's zod rules (valid email, password
// >= 8) for instant feedback. The server stays the source of truth.
function validate(email: string, password: string, inviteCode: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (INVITE_REQUIRED && !inviteCode.trim()) return "An invite code is required to sign up.";
  return null;
}

const INPUT_CLASS =
  "rounded-md border border-black/15 bg-transparent px-3 py-2 text-base outline-none " +
  "focus:border-black/40 dark:border-white/15 dark:focus:border-white/40";

export function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const isSignup = mode === "signup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // The invite code is only ever validated or sent on signup — login has no
    // such field, and passing a stale one would be a confusing no-op.
    const validationError = validate(email, password, isSignup ? inviteCode : "");
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(email, password, isSignup ? inviteCode.trim() : undefined);
      // On success the parent redirects, so we leave `submitting` true to keep
      // the button disabled through the navigation.
    } catch (err) {
      // Map the api's error shapes to one friendly line: prefer the first zod
      // field message on a 400, else the server's `error` string (e.g. 409
      // "Email already registered", 401 "Invalid email or password").
      setError(
        err instanceof ApiError
          ? err.details?.[0]?.message ?? err.message
          : "Something went wrong. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              className={INPUT_CLASS}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder="At least 8 characters"
              className={INPUT_CLASS}
            />
          </label>

          {isSignup && INVITE_REQUIRED && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Invite code
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoComplete="off"
                placeholder="Ask me for one"
                className={INPUT_CLASS}
              />
            </label>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-sm text-black/60 dark:text-white/60">
          {isSignup ? "Already have an account? " : "Need an account? "}
          <Link
            href={isSignup ? "/login" : "/signup"}
            className="font-medium underline underline-offset-4"
          >
            {isSignup ? "Sign in" : "Sign up"}
          </Link>
        </p>
      </div>
    </div>
  );
}
