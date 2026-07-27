"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { useAuth } from "@/lib/auth-context";

// A returning user already has documents, so this lands on /ask — the thing
// they signed in to do. /documents is one click away in the header; /me, the
// old destination, is a page nobody logs in *for*.
const AFTER_LOGIN = "/ask";

export default function LoginPage() {
  const router = useRouter();
  const { login, status } = useAuth();

  // Already signed in? Skip the form.
  useEffect(() => {
    if (status === "authenticated") router.replace(AFTER_LOGIN);
  }, [status, router]);

  return (
    <AuthForm
      mode="login"
      onSubmit={async (email, password) => {
        await login(email, password);
        router.push(AFTER_LOGIN);
      }}
    />
  );
}
