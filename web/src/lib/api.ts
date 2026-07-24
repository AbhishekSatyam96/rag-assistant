// Thin, typed wrapper around fetch — the client-side mirror of the api's
// route/service split. Components never call fetch directly; they call these
// typed functions, which:
//   - prefix the base URL (NEXT_PUBLIC_API_URL)
//   - send / parse JSON
//   - attach the Bearer token when one is given
//   - normalize the api's `{ error }` response shape into a thrown ApiError
//
// It holds NO state (no token, no user). State lives in the auth context, which
// passes the token in. Keeping this file pure makes it trivial to reason about
// and to reuse for the ingestion / query endpoints later.

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type AuthUser = {
  id: string;
  email: string;
};

export type AuthResponse = {
  user: AuthUser;
  token: string;
};

// A single zod issue, as the api forwards it inside a 400 body's `details` array.
type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code: string;
};

// Every failed request throws this. It carries the HTTP status plus whatever the
// server put in the body, so callers can branch on it (409 -> email taken,
// 400 -> field errors, 401 -> bad creds / expired token).
export class ApiError extends Error {
  status: number;
  details?: ValidationIssue[];

  constructor(status: number, message: string, details?: ValidationIssue[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, token } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects on network-level failures (server down, DNS, CORS
    // block) — never on a 4xx/5xx. Surface a human message, not "Failed to fetch".
    throw new ApiError(0, "Can't reach the server. Is the API running on port 4000?");
  }

  // The api always answers JSON; parse defensively in case a proxy returns HTML.
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      (data && typeof data.error === "string" && data.error) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data?.details);
  }

  return data as T;
}

export function signup(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/signup", { method: "POST", body: { email, password } });
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
}

export function getMe(token: string): Promise<{ user: AuthUser }> {
  return request<{ user: AuthUser }>("/me", { token });
}
