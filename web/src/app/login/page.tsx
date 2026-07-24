"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { login, status } = useAuth();

  // Already signed in? Skip the form.
  useEffect(() => {
    if (status === "authenticated") router.replace("/me");
  }, [status, router]);

  return (
    <AuthForm
      mode="login"
      onSubmit={async (email, password) => {
        await login(email, password);
        router.push("/me");
      }}
    />
  );
}
