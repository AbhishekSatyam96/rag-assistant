"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth-context";
import { useTheme, type Theme } from "@/lib/theme";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  IconChevronDown,
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

const NAV = [
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
            href={authed ? "/ask" : "/"}
            className="flex items-center gap-2 rounded-md pr-2 text-[15px] font-semibold tracking-tight"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent shadow-sm">
              <IconSpark className="size-4" />
            </span>
            <span className="hidden sm:inline">RAG Assistant</span>
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
              <UserMenu />
            ) : (
              <>
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
  const active = pathname === href;

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
  onSelect,
  children,
}: {
  href?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  const className =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg transition-colors duration-150 hover:bg-raised";

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
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {description && (
          <p className="mt-1.5 text-sm text-muted text-pretty">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
