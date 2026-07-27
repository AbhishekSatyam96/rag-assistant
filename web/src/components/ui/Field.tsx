"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

// The shared input surface. Three states worth naming, because getting any of
// them wrong is what makes a form feel unfinished:
//   - rest: a hairline that reads as an edge, not a box;
//   - focus: the border firms up AND an accent ring appears. Border alone is
//     too subtle at 1px; ring alone makes the field look like it moved;
//   - invalid: driven by `aria-invalid`, so the visual state and the state
//     screen readers announce can't drift apart. One attribute, both jobs.
export const CONTROL_CLASS =
  "w-full rounded-lg border border-line bg-surface px-3 text-fg shadow-sm " +
  "placeholder:text-faint transition-[border-color,box-shadow,background-color] duration-150 " +
  "hover:border-line-strong " +
  "focus:border-accent focus:ring-4 focus:ring-accent/15 focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15";

// `text-base` (16px) on inputs is not a style choice — iOS Safari zooms the
// viewport on focus for anything smaller, and there is no way back out. The
// label and hint carry the small type instead.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input ref={ref} className={cn(CONTROL_CLASS, "h-11 text-base", className)} {...props} />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL_CLASS, "resize-y py-2.5 text-base leading-relaxed scrollbar-slim", className)}
      {...props}
    />
  );
});

type FieldProps = {
  label: string;
  /** Right-aligned on the label row — character counts, "optional", limits. */
  aside?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
};

// Render-prop rather than cloning children: it hands the control its `id` and
// aria wiring explicitly, so the association between label, input, hint and
// error is visible at the call site instead of happening by magic. Wrong aria
// wiring is invisible until someone opens a screen reader, which is precisely
// why it should not be implicit.
export function Field({ label, aside, hint, error, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        {aside && <span className="text-xs text-faint tabular-nums">{aside}</span>}
      </div>

      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": message ? messageId : undefined,
      })}

      {message && (
        <p
          id={messageId}
          // role="alert" only when it IS an error — an always-alert node would
          // announce the hint text on every keystroke that re-renders it.
          role={error ? "alert" : undefined}
          className={cn("text-xs", error ? "text-danger" : "text-muted")}
        >
          {message}
        </p>
      )}
    </div>
  );
}
