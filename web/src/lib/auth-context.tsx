"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getMe, login as apiLogin, signup as apiSignup, type AuthUser } from "@/lib/api";

// Where the token lives: in React state (memory) for the running app, mirrored
// to localStorage so a page refresh doesn't log you out. Deliberate tradeoff —
// dead simple and works against the api unchanged. The production-hardening
// step is an httpOnly cookie (not readable by JS -> safer against XSS), which
// needs an api change; noted in the README.
const TOKEN_STORAGE_KEY = "rag.token";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // Starts "loading" on both server and client render, so there's no hydration
  // mismatch — the localStorage read below only runs in the browser (in effect).
  const [status, setStatus] = useState<AuthStatus>("loading");

  // On first load, rehydrate: if a token is in localStorage, prove it's still
  // good by calling /me. Missing / invalid / expired token (401) resolves to
  // "unauthenticated" — which is exactly the bounce-to-login trigger, so token
  // expiry is handled by the same path as "never logged in".
  //
  // The work lives in an async function (not the effect body) so no state is set
  // synchronously during the effect, and a `cancelled` flag drops any result
  // that arrives after unmount — e.g. if the user navigates away mid /me check.
  useEffect(() => {
    let cancelled = false;

    async function rehydrate() {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!stored) {
        if (!cancelled) setStatus("unauthenticated");
        return;
      }
      try {
        const { user } = await getMe(stored);
        if (cancelled) return;
        setUser(user);
        setToken(stored);
        setStatus("authenticated");
      } catch {
        if (cancelled) return;
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setStatus("unauthenticated");
      }
    }

    rehydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthSuccess = useCallback((nextToken: string, nextUser: AuthUser) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await apiLogin(email, password);
      handleAuthSuccess(res.token, res.user);
    },
    [handleAuthSuccess],
  );

  const signup = useCallback(
    async (email: string, password: string, inviteCode?: string) => {
      const res = await apiSignup(email, password, inviteCode);
      handleAuthSuccess(res.token, res.user);
    },
    [handleAuthSuccess],
  );

  const logout = useCallback(() => {
    // No server-side revocation yet (no refresh tokens / blocklist). This drops
    // the client's copy of the token; the token itself stays valid until it
    // expires (1h). Fine for now — flagged in the README as future work.
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(
    () => ({ user, token, status, login, signup, logout }),
    [user, token, status, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
