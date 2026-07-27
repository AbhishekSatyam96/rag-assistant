// Hand-rolled SVG icons instead of `lucide-react`.
//
// The library is the obvious choice and I'd reach for it on a team project.
// Here the app needs ~14 glyphs, and each one below is a handful of path data
// on a shared 24-grid — so the dependency would buy convenience at the cost of
// a package whose tree-shaking has to actually work to avoid shipping 1400
// icons. Fourteen inline components is a rounding error and has no such
// failure mode.
//
// All of them:
//   - inherit colour via `stroke="currentColor"`, so they take on whatever
//     token the parent text uses and need no theme handling of their own;
//   - size from the font (`w-[1em] h-[1em]` by default) unless the caller
//     overrides, so an icon next to text lines up without magic numbers;
//   - are `aria-hidden`, because every icon in this UI sits beside a real
//     label or inside a button that has an aria-label. An icon a screen reader
//     announces is almost always a bug.

import type { SVGProps } from "react";
import { cn } from "@/lib/cn";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ className, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-[1em] shrink-0", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconSpark(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5-2 2m-5 5-2 2m0-9 2 2m5 5 2 2" />
      <circle cx="12" cy="12" r="3.25" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Icon>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V4m0 0L8 8m4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2" />
    </Icon>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </Icon>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h16m0 0-6-6m6 6-6 6" />
    </Icon>
  );
}

export function IconStop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3.5 12.5 8.5 4.7 8.5-4.7M3.5 16.8l8.5 4.7 8.5-4.7" />
    </Icon>
  );
}

export function IconQuote(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 7H5.5A1.5 1.5 0 0 0 4 8.5V12h5V7Zm0 0v4c0 3.5-1.7 5.4-4 6" />
      <path d="M20 7h-3.5A1.5 1.5 0 0 0 15 8.5V12h5V7Zm0 0v4c0 3.5-1.7 5.4-4 6" />
    </Icon>
  );
}

export function IconExpand(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 3.5h-5v5M15.5 20.5h5v-5M20.5 8.5v-5h-5M3.5 15.5v5h5" />
    </Icon>
  );
}
