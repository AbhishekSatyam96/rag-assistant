"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth-context";
import { useTheme, type Theme } from "@/lib/theme";
import { LINKS } from "@/lib/site";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SiteFooter } from "@/components/SiteFooter";
import {
  IconArrowLeft,
  IconChat,
  IconChevronDown,
  IconExternal,
  IconFile,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconSearch,
  IconSpark,
  IconSun,
} from "@/components/icons";

// The app frame: one header, rendered once, instead of the three hand-rolled
// ones the pages used to carry. Those had already drifted — /ask linked to
// Documents, /documents linked to Ask *and* Account, /me linked to neither —
// which is the normal fate of copy-pasted navigation. Now adding a route means
// editing NAV below, and every page gets it.
//
// The logo links to "/" unconditionally. It used to point at /ask once you were
// signed in, which meant the landing page became unreachable the moment you
// logged in — no link anywhere in the app went back to it. On a portfolio piece
// that page IS the pitch, so a visitor who signs up and then wants to re-read
// how it works had no route there short of editing the URL. Sending a signed-in
// user to marketing isn't a real cost either: HeroActions swaps its CTAs to
// "Open the assistant" / "Your documents" when authed, so the landing page acts
// as a launcher rather than a dead end.

// Chat first, because it is the surface most people want: a thread you can ask
// follow-ups in. Ask stays because it is a genuinely different thing — one
// question, no history, no rewrite step — and it is the path the eval harness
// scores, so it needs to stay reachable and unchanged.
const NAV = [
  { href: "/chat", label: "Chat", icon: <IconChat className="size-4" /> },
  { href: "/ask", label: "Ask", icon: <IconSearch className="size-4" /> },
  { href: "/documents", label: "Documents", icon: <IconFile className="size-4" /> },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const authed = status === "authenticated";

  return (
    <div className="flex min-h-full flex-col">
      <header
        // `sticky` + a translucent background + `backdrop-blur`: content
        // scrolls *under* the header and stays legible. The border only
        // appears once there's something underneath it — see Backdrop below.
        className="sticky top-0 z-40 border-b border-line/70 bg-canvas/80 backdrop-blur-xl"
      >
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md pr-2 text-[15px] font-semibold tracking-tight"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent shadow-sm">
              <IconSpark className="size-4" />
            </span>
            {/* `sr-only`, not `hidden`. Below `sm` this link is icon-only, and
                `hidden` removes the label from the accessibility tree as well
                as the layout — leaving a link a screen reader announces as
                just "link". `sr-only` clips it visually while keeping it
                readable, and `not-sr-only` restores it at `sm`. */}
            <span className="sr-only sm:not-sr-only">RAG Assistant</span>
          </Link>

          {authed && (
            <nav className="flex items-center gap-0.5" aria-label="Main">
              {NAV.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          )}

          <div className="ml-auto flex items-center gap-2">
            {authed ? (
              // Signed in, the portfolio link lives in the user menu instead —
              // the nav pills and the account button already fill this row, and
              // a fourth item is what turns a header into a toolbar.
              <UserMenu />
            ) : (
              <>
                {/* Hidden below `sm`: on a phone this row is Sign in + Get
                    started and nothing else fits. The footer carries the same
                    link at every width, so nothing is actually lost. */}
                <a
                  href={LINKS.portfolio}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-raised hover:text-fg sm:inline-flex"
                >
                  Portfolio
                  <IconExternal className="size-3.5 text-faint" />
                </a>
                <ThemeToggleButton />
                <ButtonLink href="/login" variant="ghost" size="sm">
                  Sign in
                </ButtonLink>
                <ButtonLink href="/signup" variant="primary" size="sm">
                  Get started
                </ButtonLink>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col">{children}</main>

      <SiteFooter />
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Prefix match, not equality: /chat/<id> is still the Chat section, and an
  // exact check would drop the highlight the moment you opened a thread —
  // leaving the header claiming you are nowhere.
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      // aria-current is how a screen reader learns which page you're on. The
      // background pill communicates it to everyone else; without this
      // attribute that information is purely visual.
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors duration-150 sm:px-3",
        active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", icon: <IconSun className="size-3.5" /> },
  { value: "dark" as const, label: "Dark", icon: <IconMoon className="size-3.5" /> },
  { value: "system" as const, label: "Auto", icon: <IconMonitor className="size-3.5" /> },
];

// For signed-out pages, where there's no menu to tuck the full picker into.
// Cycles light -> dark -> system, and says which one is next in its label so
// the behaviour isn't a guess.
function ThemeToggleButton() {
  const { theme, resolved, setTheme } = useTheme();
  const next: Theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      className="size-8 px-0"
    >
      {resolved === "dark" ? <IconMoon className="size-4" /> : <IconSun className="size-4" />}
    </Button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on navigation. Without this the menu stays open over the new page,
  // because clicking a Link doesn't unmount the header.
  //
  // Done as a render-phase adjustment, not `useEffect(() => setOpen(false),
  // [pathname])`. An effect would paint the new page with the menu still open
  // and close it on the following frame — a visible flicker — and React's lint
  // rules now flag setState-in-effect for exactly this reason. Setting state
  // during render instead makes React discard this render and immediately redo
  // it with the menu closed, before anything reaches the screen.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      // `contains` on the wrapper, not the panel: the trigger is inside it too,
      // so clicking the trigger while open is handled by its own onClick
      // instead of being closed here and immediately reopened.
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus goes back where it came from. Escaping a menu and landing at the
      // top of the document is one of the most disorienting things a keyboard
      // user can experience.
      triggerRef.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  // Initials from the email's local part. Purely a visual anchor — the full
  // address is always one row below inside the menu.
  const initial = user.email[0]?.toUpperCase() ?? "?";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg pr-1.5 pl-1 transition-colors duration-150",
          open ? "bg-raised" : "hover:bg-raised",
        )}
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent">
          {initial}
        </span>
        <span className="hidden max-w-36 truncate text-[13px] text-muted sm:block">
          {user.email}
        </span>
        <IconChevronDown
          className={cn("size-3.5 text-faint transition-transform duration-150", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-64 origin-top-right animate-rise rounded-xl border border-line bg-surface p-1.5 shadow-lg"
        >
          <div className="border-b border-line px-2.5 pt-1.5 pb-2.5">
            <p className="text-[11px] text-faint">Signed in as</p>
            <p className="truncate text-[13px] font-medium text-fg" title={user.email}>
              {user.email}
            </p>
          </div>

          <div className="flex flex-col gap-1 border-b border-line px-2.5 py-2.5">
            <p className="text-[11px] text-faint">Theme</p>
            <SegmentedControl
              label="Theme"
              size="sm"
              value={theme}
              onChange={setTheme}
              options={THEME_OPTIONS}
              className="w-full [&>button]:flex-1"
            />
          </div>

          <div className="pt-1.5">
            <MenuItem href="/me" onSelect={() => setOpen(false)}>
              <IconSpark className="size-4 text-faint" />
              Account
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setOpen(false);
                logout();
                // Push rather than letting useRequireAuth's redirect fire: from
                // a public page (/) logging out wouldn't redirect at all, and
                // the header would just silently change. Being sent to /login
                // is the unambiguous confirmation that it worked.
                router.push("/login");
              }}
            >
              <IconLogout className="size-4 text-faint" />
              Log out
            </MenuItem>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  href,
  external,
  onSelect,
  children,
}: {
  href?: string;
  /** Renders a plain <a target="_blank"> instead of a Link. */
  external?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const className =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg transition-colors duration-150 hover:bg-raised";

  // A plain anchor rather than next/link: Link's prefetching and client-side
  // routing are meaningless for a different origin, and it would try to
  // intercept the click before the browser could hand it to a new tab.
  if (href && external) {
    return (
      <a
        role="menuitem"
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={onSelect}
        className={className}
      >
        {children}
      </a>
    );
  }

  if (href) {
    return (
      <Link role="menuitem" href={href} onClick={onSelect} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <button role="menuitem" type="button" onClick={onSelect} className={className}>
      {children}
    </button>
  );
}

// The h1 + subtitle block that opens /ask, /documents and /me. Extracted purely
// so the three don't drift in size and spacing the way their headers did.
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  // One object rather than `backHref` + `backLabel`, so "an href with no label"
  // is unrepresentable instead of merely discouraged.
  //
  // `href` is required and there is deliberately no router.back() variant. A
  // history-based back button does something different depending on how you
  // arrived — from in-app nav it goes where you expect, from a pasted URL or a
  // search result it leaves the app entirely. An explicit destination behaves
  // identically in all three cases, which is the whole point of the control.
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-8">
      {back && (
        <Link
          href={back.href}
          // `-ml-1` cancels the horizontal padding so the arrow's optical left
          // edge lines up with the h1 below it rather than sitting a few pixels
          // inside it — the padding is only there to give the hover state room.
          className="mb-2 -ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] text-muted transition-colors duration-150 hover:text-fg"
        >
          <IconArrowLeft className="size-3.5" />
          {back.label}
        </Link>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
          {description && (
            <p className="mt-1.5 text-sm text-muted text-pretty">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
