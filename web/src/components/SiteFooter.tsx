"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AUTHOR, COPYRIGHT_YEAR, LINKS } from "@/lib/site";
import {
  IconArrowUp,
  IconExternal,
  IconGitHub,
  IconLinkedIn,
  IconMail,
  IconSpark,
} from "@/components/icons";

// The footer, deliberately shaped like the one on abhisheksatyam.com: identity
// on the left, icon buttons and a back-to-top on the right, a hairline, then
// the copyright row. Someone who arrives here from the portfolio should
// recognise the furniture — that continuity is the whole point of a project
// living on a subdomain rather than a random URL.
//
// It is NOT a pixel copy. The colours are this app's semantic tokens, so the
// footer themes with everything else instead of pinning one palette; matching
// the portfolio's exact hex values would have looked correct in dark mode and
// broken in light.
//
// "use client" only because of the back-to-top button below. That costs nothing
// here: AppShell is already a client component, so this subtree was never going
// to be server-rendered-only regardless.

export function SiteFooter() {
  return (
    // No `mt-auto` needed to pin this to the bottom on short pages: AppShell's
    // <main> already carries `flex-1` inside a `min-h-full` column, so it
    // absorbs the slack and the footer lands under the fold either way.
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <div className="flex flex-col gap-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <IconSpark className="size-4.5" />
            </span>
            <div className="min-w-0">
              {/* The name itself is the link home. A person's name is the most
                  clickable thing in any footer — making it inert and putting
                  "Portfolio" elsewhere is a needless extra hop. */}
              <a
                href={LINKS.portfolio}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1.5 text-sm font-semibold text-fg"
              >
                {AUTHOR.name}
                <IconExternal className="size-3 text-faint transition-colors group-hover:text-accent" />
              </a>
              {/* Mono, echoing the portfolio's own footer subtitle. */}
              <p className="mt-0.5 font-mono text-[12px] text-muted">
                {AUTHOR.role} · {AUTHOR.location}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <IconButton href={LINKS.email} label={`Email ${AUTHOR.name}`}>
              <IconMail className="size-4" />
            </IconButton>
            <IconButton href={LINKS.linkedin} label={`${AUTHOR.name} on LinkedIn`} external>
              <IconLinkedIn className="size-4" />
            </IconButton>
            <IconButton href={LINKS.github} label={`${AUTHOR.name} on GitHub`} external>
              <IconGitHub className="size-4" />
            </IconButton>
            <BackToTop />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-line py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-muted">
            © {COPYRIGHT_YEAR} {AUTHOR.name}. Built with Next.js, Express & pgvector.
          </p>

          <nav aria-label="Elsewhere" className="flex items-center gap-4 text-[13px]">
            <FooterLink href={LINKS.portfolio}>Portfolio</FooterLink>
            <FooterLink href={LINKS.projects}>Projects</FooterLink>
            <FooterLink href={LINKS.repo}>Source</FooterLink>
          </nav>
        </div>
      </div>
    </footer>
  );
}

// Icon-only, so the accessible name has to come from aria-label — and it names
// the destination ("Abhishek Satyam on GitHub"), not the glyph ("GitHub icon").
// A screen-reader user hearing "GitHub" three rows in has no idea whose.
function IconButton({
  href,
  label,
  external,
  children,
}: {
  href: string;
  label: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      // mailto: opens a mail client rather than a page, so a new tab would
      // leave an empty one behind. Only real navigations get _blank.
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={cn(
        "flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted",
        "transition-colors duration-150 hover:border-line-strong hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </a>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-muted transition-colors duration-150 hover:text-fg"
    >
      {children}
    </a>
  );
}

// Same affordance as the portfolio's footer. A <button>, not an <a href="#top">
// — there is no #top element, and an anchor to nowhere puts a junk fragment in
// the URL and in the back-button history.
function BackToTop() {
  return (
    <button
      type="button"
      onClick={() => {
        // Smooth scrolling is animation, and the CSS override in globals.css
        // can't reach an option passed to scrollTo — that argument beats the
        // stylesheet. So the media query is re-checked here, in JS.
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
      }}
      aria-label="Back to top"
      title="Back to top"
      className="flex size-9 items-center justify-center rounded-lg border border-accent-line bg-accent-soft text-accent transition-colors duration-150 hover:bg-accent hover:text-on-accent"
    >
      <IconArrowUp className="size-4" />
    </button>
  );
}
