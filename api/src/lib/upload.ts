// The upload size limit, and the sentence that describes it, in one place.
//
// WHY THIS FILE EXISTS. The limit used to live as a constant in
// document.routes.ts while middleware/error.ts spelled the number out in prose,
// on the reasoning that "the middleware has no business importing a route's
// constant just to format a sentence." That is a good instinct about layering
// and it was the wrong trade: the moment the cap moved from 10 MB to 4 MB for
// Vercel's request-body limit, the enforcement changed and the error message
// did not. The user is then told a limit that is not the limit — which is worse
// than no number at all, because they will trust it and retry at 9 MB.
//
// A shared constant in lib/ costs one import and makes the drift impossible.
// Enforcement and explanation are not two concerns; they are one fact.

/**
 * Maximum accepted upload, in bytes.
 *
 * Sized to sit under Vercel's hard 4.5 MB request-body limit, not from anything
 * about PDFs. Past that ceiling the platform returns its own
 * 413 FUNCTION_PAYLOAD_TOO_LARGE at the edge; the request never reaches Express,
 * so our MulterError handling never runs and the caller gets a Vercel error page
 * instead of this API's `{ error }` shape.
 *
 * The margin below 4.5 is deliberate: multer caps the FILE, while the multipart
 * body additionally carries boundaries, part headers and the `title` field, so
 * the wire size always exceeds the file size.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The same limit rendered for humans, e.g. "4 MB". */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
