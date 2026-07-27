"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

// Theme = what the user asked for. "system" defers to the OS, and keeps
// deferring — flipping macOS to dark at sunset updates a tab that's been open
// all day, which a resolved-once-at-load implementation gets wrong.
export type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

const STORAGE_KEY = "rag.theme";

// Inlined into <head> and run BEFORE the first paint. Without it the page
// renders at the CSS default (light), then the provider flips it — a white
// flash on every load for dark-mode users, which is the exact detail that
// makes a UI feel cheap.
//
// It has to be a string because it must execute before React exists. Kept to
// one statement, and wrapped in try/catch: localStorage throws outright in
// Safari private mode, and an uncaught error in a blocking head script would
// take the rest of the page's inline setup with it.
export const THEME_SCRIPT = `
(function(){try{
  var s=localStorage.getItem("${STORAGE_KEY}");
  var t=s==="light"||s==="dark"?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
  document.documentElement.dataset.theme=t;
}catch(e){document.documentElement.dataset.theme="dark";}})();
`;

// ---------------------------------------------------------------------------
// Two external stores, read with useSyncExternalStore.
//
// localStorage and matchMedia are mutable state that lives OUTSIDE React, and
// this is the hook built for exactly that. The obvious alternative — useState
// plus an effect that reads them on mount — is what this replaced, and it has
// two real problems beyond the lint rule that flags it: it renders once with a
// wrong value before correcting itself, and it silently tears if two
// components ever read the same source. useSyncExternalStore has neither,
// and it takes an explicit server snapshot so SSR is a decision rather than a
// crash on `window is not defined`.
// ---------------------------------------------------------------------------

// localStorage fires `storage` in OTHER tabs, never the one that wrote it. So
// same-tab updates need this manual fan-out, and cross-tab sync comes free
// from the event — together they mean changing the theme in one tab updates
// every open tab.
const listeners = new Set<() => void>();

function subscribePreference(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readPreference(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function subscribeSystem(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function readSystem(): Resolved {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The server has no localStorage and no OS preference, so it renders "system"
// resolving to dark — matching the head script's own fallback. Nothing visual
// depends on this being right: the script has already set the real theme on
// <html> before React hydrates.
const serverPreference = (): Theme => "system";
const serverSystem = (): Resolved => "dark";

type ThemeContextValue = {
  theme: Theme;
  resolved: Resolved;
  setTheme: (next: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribePreference, readPreference, serverPreference);
  const system = useSyncExternalStore(subscribeSystem, readSystem, serverSystem);

  // Derived, not stored. There is exactly one way to be dark, and it's computed
  // — so it can't drift out of sync with the two things it's computed from.
  const resolved: Resolved = theme === "system" ? system : theme;

  // The one legitimate effect here: pushing React's state OUT to an external
  // system (the DOM attribute the CSS keys off). That's what effects are for,
  // and it's why this one doesn't trip the same rule the old code did.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    // Colours crossfade on a deliberate toggle, but page loads and navigations
    // stay instant. A permanent transition on `*` would make every hover feel
    // laggy, so the class goes on for the length of the animation only.
    const root = document.documentElement;
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 200);

    try {
      // "system" is stored as *absence*. Writing the literal string would be
      // indistinguishable from a stale value on the next visit, and the head
      // script would have to know about a third state.
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode. The theme still applies for this page — the effect above
      // runs off React state, not off storage — it just won't be remembered.
    }

    // Tell every useSyncExternalStore subscriber to re-read. Without this the
    // write lands in localStorage and nothing re-renders.
    listeners.forEach((listener) => listener());
  }, []);

  const value = useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
