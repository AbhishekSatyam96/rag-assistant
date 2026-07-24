"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { useAuth } from "@/lib/auth-context";

export default function SignupPage() {
  const router = useRouter();
  const { signup, status } = useAuth();

  // Already signed in? Skip the form.
  useEffect(() => {
    if (status === "authenticated") router.replace("/me");
  }, [status, router]);

  return (
    <AuthForm
      mode="signup"
      onSubmit={async (email, password) => {
        await signup(email, password);
        router.push("/me");
      }}
    />
  );
}
