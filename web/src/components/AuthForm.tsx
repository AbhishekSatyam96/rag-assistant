"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";
import { IconSpark } from "@/components/icons";

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
          ? (err.details?.[0]?.message ?? err.message)
          : "Something went wrong. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 opacity-60 [background:radial-gradient(50%_50%_at_50%_0%,var(--accent-soft)_0%,transparent_70%)]"
      />

      <div className="w-full max-w-104 animate-rise">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-line bg-surface text-accent shadow-sm">
            <IconSpark className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">
            {isSignup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {isSignup
              ? "Start building your own grounded knowledge base."
              : "Sign in to your documents and answers."}
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-md">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            {/* Every field is invalid together or not at all, because validation
                produces one message rather than a per-field map. Passing `error`
                to each Field would paint three red borders for one mistake, so
                the message lives in a single Alert below instead. */}
            <Field label="Email">
              {(field) => (
                <Input
                  {...field}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus
                  placeholder="you@example.com"
                />
              )}
            </Field>

            <Field
              label="Password"
              hint={isSignup ? "At least 8 characters." : undefined}
            >
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  placeholder="••••••••"
                />
              )}
            </Field>

            {isSignup && INVITE_REQUIRED && (
              <Field label="Invite code">
                {(field) => (
                  <Input
                    {...field}
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                    placeholder="Ask me for one"
                  />
                )}
              </Field>
            )}

            {error && <Alert tone="error">{error}</Alert>}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              className="mt-1 w-full"
            >
              {isSignup ? "Create account" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          {isSignup ? "Already have an account? " : "Need an account? "}
          <Link
            href={isSignup ? "/login" : "/signup"}
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            {isSignup ? "Sign in" : "Sign up"}
          </Link>
        </p>
      </div>
    </div>
  );
}
