"use client";

import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/use-require-auth";
import { PageHeader } from "@/components/AppShell";
import { PageLoading } from "@/components/ui/PageLoading";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconArrowRight, IconLogout } from "@/components/icons";

// The protected page — the frontend mirror of the api's /me smoke test. Its
// content comes straight from the token the api validated.
export default function MePage() {
  const router = useRouter();
  // The redirect-if-unauthenticated guard used to live here as a local effect;
  // it moved into useRequireAuth so /documents shares it verbatim.
  const { user, status, logout } = useRequireAuth();

  if (status !== "authenticated" || !user) return <PageLoading />;

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader
        title="Account"
        description="Everything the API knows about you, straight from the validated token."
      />

      <Card className="divide-y divide-line">
        <Row label="Email" value={user.email} />
        <Row label="User ID" value={user.id} mono />
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <ButtonLink href="/ask" variant="primary">
          Ask a question
          <IconArrowRight className="size-4" />
        </ButtonLink>
        <ButtonLink href="/documents">Documents</ButtonLink>
        <Button
          variant="danger"
          className="ml-auto"
          onClick={() => {
            logout();
            router.push("/login");
          }}
        >
          <IconLogout className="size-4" />
          Log out
        </Button>
      </div>
    </div>
  );
}

// A definition row. `break-all` on the value because a user id is an
// unbreakable 25-character string that would otherwise push the card wide
// enough to scroll the page sideways on a phone.
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
      <dt className="w-28 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className={`min-w-0 break-all text-sm text-fg ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
