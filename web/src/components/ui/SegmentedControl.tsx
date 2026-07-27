"use client";

import { cn } from "@/lib/cn";

// The "two modes, one form" switch (paste text / upload PDF), and the theme
// picker. Generic over the option value so the caller keeps its own union type
// — `onChange` hands back `Mode`, not `string`, which means a typo'd option is
// a compile error.
type Option<T extends string> = { value: T; label: string; icon?: React.ReactNode };

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the group for screen readers — "Ingestion method", "Theme". */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-line bg-raised p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            // radio, not tab: these switch a form's *inputs*, they don't reveal
            // panels. Announcing "tab" would promise a tabpanel that isn't
            // there. `aria-checked` gives the selected state either way.
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors duration-150",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              active
                ? "bg-surface text-fg shadow-sm"
                : "text-muted hover:text-fg",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
