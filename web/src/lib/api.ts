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

// WHY THIS IS NOT JUST `?? "http://localhost:4000"`.
//
// NEXT_PUBLIC_* is substituted at BUILD time by literal text replacement — it is
// not read at runtime. So a production build made without the variable set does
// not fall back to anything sensible; it ships a bundle that asks every
// visitor's own machine for the API. That fails as a connection error with no
// server-side trace, on the visitor's browser, and setting the variable
// afterwards fixes nothing until the app is rebuilt.
//
// A silent localhost fallback is therefore only ever correct in development. In
// a production build its absence is a deploy misconfiguration, and the right
// time to find out is while building — not from a user reporting that nothing
// loads. Same fail-fast reasoning as lib/env.ts on the api side.
function resolveBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. It is baked in at build time, so this " +
        "bundle would point every visitor at http://localhost:4000. Set it on " +
        "the deployment (e.g. https://api.abhisheksatyam.com) and rebuild.",
    );
  }

  return "http://localhost:4000";
}

const BASE_URL = resolveBaseUrl();

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

// Mirrors the api's DocStatus enum. Ingestion is a state machine, not a
// boolean: PENDING -> PROCESSING -> READY | FAILED.
export type DocStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

// The api's `documentSelect` shape. Note what is absent: `content`, the full
// raw text. The server never sends it, so a user with 50 documents doesn't
// download their whole corpus to render this list.
//
// `createdAt` is a STRING here, not a Date — it went through JSON, which has no
// date type. Parse it at the point of display, never assume it's a Date.
export type DocumentSummary = {
  id: string;
  title: string;
  status: DocStatus;
  chunkCount: number;
  error: string | null;
  createdAt: string;
};

export function isProcessing(doc: DocumentSummary): boolean {
  return doc.status === "PENDING" || doc.status === "PROCESSING";
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
};

// Turns the api's error body into an ApiError. Shared by all three transports
// below (JSON, multipart, streaming) so a 429 from the rate limiter reads the
// same however it was triggered — the api always answers `{ error }`, and the
// one place that shape is decoded should be one place.
function apiError(status: number, data: unknown): ApiError {
  const body = data as { error?: unknown; details?: ValidationIssue[] } | null;
  const message =
    typeof body?.error === "string" ? body.error : `Request failed (${status})`;
  return new ApiError(status, message, body?.details);
}

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

  if (!res.ok) throw apiError(res.status, data);

  return data as T;
}

// `inviteCode` is sent only when the deployment is running invite-only (the api
// requires it when SIGNUP_INVITE_CODE is set, and ignores it otherwise), so it
// is optional here rather than a separate function. A wrong or missing code
// comes back as a 403 whose `error` string the form renders like any other
// server message — no special-casing needed in the UI.
export function signup(
  email: string,
  password: string,
  inviteCode?: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/signup", {
    method: "POST",
    body: { email, password, inviteCode },
  });
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
}

export function getMe(token: string): Promise<{ user: AuthUser }> {
  return request<{ user: AuthUser }>("/me", { token });
}

// --- documents ---------------------------------------------------------------

// Ingestion is currently synchronous: this promise resolves once the api has
// chunked and embedded the text, which takes a few seconds for a real document.
// `document.status` will normally already be READY.
//
// Callers must NOT rely on that. The api is designed to switch to 202 Accepted
// + PENDING later, and the contract deliberately reads as "here is the document
// and its status right now" — so treat the result as a starting point and poll
// until the status is terminal. That way the change costs the frontend nothing.
//
// `deduped` is true when this exact text was already ingested: no new document
// was created and the existing one came back untouched (the api answers 200
// instead of 201).
export function createDocument(
  token: string,
  input: { title: string; content: string },
): Promise<{ document: DocumentSummary; deduped: boolean }> {
  return request<{ document: DocumentSummary; deduped: boolean }>("/documents", {
    method: "POST",
    body: input,
    token,
  });
}

// The upload ceiling, mirrored from MAX_UPLOAD_BYTES in the api's
// lib/upload.ts. Checked client-side purely so an oversized file is refused
// instantly instead of after a full upload — the server limit is the one that
// actually enforces anything.
//
// 4 MB is not a judgement about PDFs: it sits under Vercel's hard 4.5 MB
// request-body limit, above which the platform rejects the request at the edge
// with its own error page, before the API can answer in its usual `{ error }`
// shape. Two codebases cannot share a constant across an HTTP boundary, so this
// is a mirror and will drift if the server value changes without this one.
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

// PDF upload. Resolves to the SAME `{ document, deduped }` shape as
// createDocument, which is what lets the documents page reuse one handler, one
// renderer and one polling loop for both ingestion routes.
//
// WHY THIS DOESN'T GO THROUGH `request()`
// Same reason streamAsk doesn't: `request()` unconditionally JSON.stringifies
// the body and sets `Content-Type: application/json`. Neither is right here.
//
// THE ONE THING TO GET RIGHT: do NOT set Content-Type yourself. The browser
// generates it for a FormData body as
// `multipart/form-data; boundary=----WebKitFormBoundary…`, and that boundary
// token is what tells the server where each part begins. Hard-code the header
// and the boundary is missing, multer cannot split a body it was told is
// multipart, and the failure surfaces as an opaque server error — which sends
// you debugging the backend for something the client did.
export function uploadPdf(
  token: string,
  file: File,
  title?: string,
): Promise<{ document: DocumentSummary; deduped: boolean }> {
  const form = new FormData();
  // Field name must match `upload.single("file")` on the server.
  form.append("file", file);
  // Only send a title when there is one — the api falls back to the filename,
  // and an empty string would just be noise on the wire.
  if (title?.trim()) form.append("title", title.trim());

  return uploadRequest("/documents/upload", form, token);
}

async function uploadRequest<T>(path: string, form: FormData, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      // Authorization only. See the Content-Type note above.
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Is the API running on port 4000?");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(res.status, data);
  return data as T;
}

export function listDocuments(token: string): Promise<{ documents: DocumentSummary[] }> {
  return request<{ documents: DocumentSummary[] }>("/documents", { token });
}

// Returns the identical shape to createDocument's `document`, which is what
// makes a polling loop trivial — no special-casing the response that started it.
export function getDocument(
  token: string,
  id: string,
): Promise<{ document: DocumentSummary }> {
  return request<{ document: DocumentSummary }>(`/documents/${id}`, { token });
}

// --- queries (streaming) -----------------------------------------------------

// A citation. `n` is the marker the model wrote into its prose: the text
// "...as covered in the handbook [2]" refers to the source whose `n` is 2. The
// server sends `n` explicitly rather than letting us infer it from array
// position, so the mapping can't drift if this list is ever filtered or sorted.
export type Source = {
  n: number;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  // Set only for documents ingested from a PDF, where chunking is page-aware.
  // Null for every pasted-text document and null forever — so the UI needs a
  // real fallback, not a loading state.
  page: number | null;
  content: string;
  similarity: number;
};

// Mirrors the api's QueryEvent union exactly. Kept as a discriminated union so
// a `switch (event.type)` narrows the payload and the compiler flags an
// unhandled case if the server ever adds one.
export type QueryEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "token"; value: string }
  | { type: "done"; answer: string }
  | { type: "error"; message: string };

// Why this doesn't use `request()` above: that helper does `await res.json()`,
// which waits for the ENTIRE body before resolving — the exact opposite of what
// a stream is for. Streaming needs the raw `res.body` reader, so it gets its own
// function rather than a flag on the shared one.
//
// Why fetch + ReadableStream and not EventSource/SSE: EventSource cannot set
// request headers, and our auth is a Bearer token. SSE would mean putting the
// token in the query string, where it ends up in server access logs and browser
// history. This is a hard constraint of the auth design, not a style choice.
//
// An async generator, so consumers write `for await (const event of streamAsk())`
// — ordinary control flow, where `break` cancels and `try/catch` catches.
export async function* streamAsk(
  token: string,
  input: { question: string; k?: number },
  signal?: AbortSignal,
): AsyncGenerator<QueryEvent> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/queries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal,
    });
  } catch (err) {
    // An abort surfaces here as an exception too. Rethrow it untouched so the
    // caller can tell "I cancelled this" apart from "the server is unreachable"
    // — otherwise clicking Stop renders a scary connection error.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the server. Is the API running on port 4000?");
  }

  // A failure BEFORE the stream started is an ordinary JSON error response with
  // a real status code — the server defers its headers precisely so this stays
  // possible. Handle it exactly like every other request, so a 401 here behaves
  // the same as a 401 anywhere else.
  if (!res.ok) throw apiError(res.status, await res.json().catch(() => null));

  if (!res.body) throw new ApiError(0, "Streaming is not supported in this browser.");

  const reader = res.body.getReader();
  // `stream: true` is load-bearing. A UTF-8 character can be up to 4 bytes, and
  // a network chunk can split one down the middle. Without it, TextDecoder
  // treats each chunk as a complete document and emits U+FFFD (�) for the
  // dangling bytes; with it, the decoder holds the partial character back until
  // the rest arrives. Bugs from this only appear on non-ASCII output, which is
  // why they reliably survive to production.
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // The OTHER half of the same problem, at the line level: a network chunk
      // has nothing to do with a line boundary. One read can deliver two and a
      // half events, and the next delivers the missing half. So we accumulate
      // into `buffer` and only consume up to the last complete newline — the
      // remainder stays buffered for the next read. `JSON.parse(chunk)` without
      // this works perfectly on short answers and fails on long ones, which is
      // the worst possible failure schedule.
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as QueryEvent;
      }
    }

    // The server always terminates its final event with a newline, so anything
    // left here means the stream was cut mid-event. Parse it only if it happens
    // to be valid JSON; a truncated fragment is dropped rather than thrown,
    // because the tokens already delivered are still worth showing.
    const rest = buffer.trim();
    if (rest) {
      try {
        yield JSON.parse(rest) as QueryEvent;
      } catch {
        /* truncated trailing fragment — ignore */
      }
    }
  } finally {
    // Runs on early `break`, on an exception, and on abort. Without it, a
    // consumer that stops reading leaves the connection open and the browser
    // holding a lock on the stream. `finally` in a generator fires when the
    // generator is disposed, which is exactly the guarantee needed here.
    reader.cancel().catch(() => {});
  }
}
