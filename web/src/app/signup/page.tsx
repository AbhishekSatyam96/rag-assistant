"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { useAuth } from "@/lib/auth-context";

// A new account has an empty library, so this lands on /documents, not /ask.
// It used to send everyone to /me — a page whose entire content is the email
// they just typed and a 25-character user id. That is a debugging view, and
// making it the first thing a signed-up visitor sees wasted the one moment
// where they're most willing to do the next step.
const AFTER_SIGNUP = "/documents";

export default function SignupPage() {
  const router = useRouter();
  const { signup, status } = useAuth();

  // Already signed in? Skip the form.
  useEffect(() => {
    if (status === "authenticated") router.replace(AFTER_SIGNUP);
  }, [status, router]);

  return (
    <AuthForm
      mode="signup"
      onSubmit={async (email, password, inviteCode) => {
        await signup(email, password, inviteCode);
        router.push(AFTER_SIGNUP);
      }}
    />
  );
}
