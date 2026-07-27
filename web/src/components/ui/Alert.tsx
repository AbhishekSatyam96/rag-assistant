import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconAlert, IconCheck } from "@/components/icons";

type Tone = "error" | "info" | "success";

const TONES: Record<Tone, { box: string; icon: ReactNode }> = {
  error: {
    box: "border-danger/30 bg-danger-soft text-danger",
    icon: <IconAlert className="mt-px size-4" />,
  },
  info: {
    box: "border-line bg-raised text-muted",
    icon: <IconAlert className="mt-px size-4" />,
  },
  success: {
    box: "border-success/30 bg-success-soft text-success",
    icon: <IconCheck className="mt-px size-4" />,
  },
};

export function Alert({
  tone = "error",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  const { box, icon } = TONES[tone];

  return (
    <div
      // Errors are announced; info and success are not. `role="alert"` is
      // aggressive — it interrupts whatever a screen reader is currently
      // saying — so it's reserved for the case where the user's action failed
      // and they need to know before doing anything else.
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed",
        box,
        className,
      )}
    >
      {icon}
      <span className="min-w-0 wrap-break-word">{children}</span>
    </div>
  );
}
