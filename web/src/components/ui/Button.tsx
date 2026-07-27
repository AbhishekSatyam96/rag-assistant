"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

// Variants are a closed union rather than free-form classes. The point isn't
// type safety for its own sake — it's that `variant="primary"` is a decision
// ("this is the one action on the page") while a class string is a description
// ("this is indigo"). When the accent changes, decisions survive and
// descriptions don't.
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const BASE =
  "relative inline-flex items-center justify-center gap-2 rounded-lg font-medium " +
  "whitespace-nowrap transition-[background-color,border-color,color,transform,opacity] " +
  "duration-150 active:translate-y-px " +
  // `disabled:` covers the real attribute; `aria-disabled` covers links, which
  // can't be disabled at all. Both routed to one style so a disabled anything
  // looks the same.
  "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45";

const VARIANTS: Record<Variant, string> = {
  // The inset top highlight is what stops a flat fill looking like a coloured
  // rectangle — it fakes a light source, which is the entire trick behind why
  // buttons in polished dark UIs read as physical.
  primary:
    "bg-accent text-on-accent shadow-sm hover:bg-accent-hover " +
    "inset-shadow-[0_1px_0_oklch(1_0_0/0.22)]",
  secondary: "border border-line bg-surface text-fg shadow-sm hover:bg-raised hover:border-line-strong",
  ghost: "text-muted hover:bg-raised hover:text-fg",
  danger: "border border-line bg-surface text-danger shadow-sm hover:bg-danger-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  /** Swaps the content for a spinner and blocks interaction. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // A <button> inside a <form> defaults to type="submit". Defaulting it to
      // "button" here means the dangerous case has to be asked for explicitly,
      // instead of being what you get by forgetting. DocumentForm's mode tabs
      // used to carry a comment explaining this exact trap; now it can't happen.
      type="button"
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {/* The label stays mounted and goes invisible rather than being replaced,
          so the button doesn't resize when it starts loading — a button that
          shrinks under the cursor is how you get an accidental double-submit
          on the element that lands where it used to be. */}
      <span className={cn("contents", loading && "invisible")}>{children}</span>
      {loading && <Spinner className="absolute" />}
    </button>
  );
}

// Same visual language for things that navigate. Sharing the class builders
// (rather than a `<Button as={Link}>` polymorphic component) keeps both call
// sites fully typed with no generic gymnastics — and a link and a button are
// genuinely different elements, which is worth keeping visible in the markup.
export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  children,
  href,
  ...props
}: CommonProps & { href: string } & Omit<
    React.ComponentPropsWithoutRef<typeof Link>,
    "href" | "className" | "children"
  >) {
  return (
    <Link
      href={href}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {children}
    </Link>
  );
}
