// A small error type that carries an HTTP status code. Services throw these
// (e.g. `throw new HttpError(409, "Email already registered")`) and the central
// error middleware turns them into the right response. This keeps HTTP status
// decisions next to the business rule that triggered them, not scattered in
// route handlers.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
