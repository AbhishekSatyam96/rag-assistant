// A small error type that carries an HTTP status code. Services throw these
// (e.g. `throw new HttpError(409, "Email already registered")`) and the central
// error middleware turns them into the right response. This keeps HTTP status
// decisions next to the business rule that triggered them, not scattered in
// route handlers.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // When we wrap a lower-level failure (a driver error, a failed API call) in
    // a friendly HTTP message, the original must survive as `cause` — otherwise
    // the only thing reaching the logs is "500 Failed to ingest document",
    // which tells you nothing about WHY. Node prints the cause chain for free.
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HttpError";
  }
}
