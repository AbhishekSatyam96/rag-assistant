// Reading an NDJSON stream — one JSON object per line — off a fetch Response.
//
// This was lifted verbatim out of `streamAsk` in lib/api.ts when a second
// streaming endpoint (chat) arrived. It is extracted rather than copied for one
// specific reason: the two bugs guarded against below are both invisible in
// development and both fatal in production, and a copy means the next fix lands
// in one of two places. There is now exactly one implementation to get right.
//
// Why NDJSON and not Server-Sent Events, since that question always comes up:
// EventSource cannot set request headers, and auth here is a Bearer token. SSE
// would force the token into a query string, where it lands in access logs,
// browser history and Referer headers. That is a constraint of the auth design,
// not a preference. See the matching note in the api's query.routes.ts.

// Generic over the event union so each caller keeps its own exhaustive `switch`.
// Note what this cannot do: `JSON.parse` returns `any`, so `T` is an unchecked
// assertion about what the server sends, exactly like Prisma's `$queryRaw`. The
// discriminated unions on both sides are what make that assertion survivable —
// a new event type added server-side shows up as an unhandled case at the call
// site rather than as a runtime surprise here.
export async function* readNdjson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();

  // `stream: true` on every decode call is load-bearing. A UTF-8 character can
  // be up to 4 bytes and a network chunk can split one down the middle. Without
  // it, TextDecoder treats each chunk as a complete document and emits U+FFFD
  // (the replacement character) for the dangling bytes; with it, the decoder
  // holds the partial character back until the rest arrives.
  //
  // This only ever breaks on non-ASCII output — an accented word, an em dash, an
  // emoji — which is why it reliably survives every English-language test and
  // reaches production intact.
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // The SAME problem one level up, at the line boundary: a network chunk has
      // nothing to do with a newline either. One read can deliver two and a half
      // events and the next delivers the missing half. So accumulate into
      // `buffer` and only consume up to the last complete newline, leaving the
      // remainder for the next read.
      //
      // `JSON.parse(chunk)` without this works perfectly on short answers and
      // fails on long ones — the worst possible failure schedule, because the
      // tests that pass are the ones you wrote first.
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }

    // The server always terminates its final event with a newline, so anything
    // left in the buffer here means the stream was cut mid-event. Parse it only
    // if it happens to be valid JSON; a truncated fragment is dropped rather
    // than thrown, because the tokens already delivered are still worth showing.
    const rest = buffer.trim();
    if (rest) {
      try {
        yield JSON.parse(rest) as T;
      } catch {
        /* truncated trailing fragment — ignore */
      }
    }
  } finally {
    // Runs on early `break`, on an exception, and on abort. Without it a
    // consumer that stops reading leaves the connection open and the browser
    // holding a lock on the stream. `finally` in a generator fires when the
    // generator is disposed, which is exactly the guarantee needed here.
    reader.cancel().catch(() => {});
  }
}
