// The audio upload boundary: how much we accept, and what we accept.
//
// Modelled on lib/upload.ts, which holds the same two facts for PDFs, and split
// from it rather than sharing its constant because the two limits are sized from
// completely different things. A PDF's cap comes from Vercel's request-body
// limit; audio's comes from what a minute of speech costs to transcribe.

/**
 * Maximum accepted recording, in bytes.
 *
 * BYTES ARE A PROXY FOR MINUTES, AND THE PROXY IS CODEC-DEPENDENT. Transcription
 * is billed per minute of audio, which is the thing that actually needs
 * bounding — but nothing here decodes the file, so duration is not knowable
 * before the paid call. Bytes are what we can check for free.
 *
 * 1 MB is roughly five minutes of the Opus that every browser's MediaRecorder
 * produces, which is far longer than anyone speaks a question for, and the
 * client stops recording at 60s anyway. The same 1 MB is only ~10 seconds of
 * uncompressed WAV — a worse deal, but no browser reaches for WAV here, and
 * erring toward the compressed case is erring toward the case that exists.
 *
 * Well under Vercel's hard 4.5 MB request-body limit, so unlike the PDF route
 * this cap is never the second-tightest one: a rejection always comes from this
 * API, in this API's `{ error }` shape, rather than from the platform's edge.
 */
export const MAX_AUDIO_BYTES = 1024 * 1024;

/** The same limit rendered for humans, e.g. "1 MB". */
export const MAX_AUDIO_LABEL = `${MAX_AUDIO_BYTES / (1024 * 1024)} MB`;

/**
 * Floor below which a recording cannot contain speech.
 *
 * A container header plus a handful of frames is a few hundred bytes, so
 * anything under 2 KB is a click on the mic button rather than a question. This
 * is cheap insurance against the failure mode that matters most on this route:
 * transcription models are known to HALLUCINATE on silence, returning fluent
 * text ("Thank you.", subtitle credits) for an empty clip. That text then flows
 * into retrieval as if the user had asked for it.
 *
 * To be precise about what this does and doesn't buy: it stops the empty case,
 * not the quiet-room case. A real 3-second recording of nothing is well over
 * 2 KB and still hallucinatable. The client-side level gate in
 * web/src/lib/use-recorder.ts is what handles that one, because measuring
 * loudness needs the decoded samples the browser already has and this side does
 * not.
 */
export const MIN_AUDIO_BYTES = 2048;

/** Container formats we accept, mapped to the extension OpenAI dispatches on. */
export type AudioExt = "webm" | "mp4" | "ogg" | "wav";

function startsWith(buffer: Buffer, offset: number, ascii: string): boolean {
  return buffer.subarray(offset, offset + ascii.length).toString("latin1") === ascii;
}

/**
 * Identify the container from its leading bytes, or return null.
 *
 * CONTENT-TYPE IS A CLAIM; MAGIC BYTES ARE EVIDENCE — the same rule the PDF
 * route applies with its `%PDF-` check, and for the same reason: `file.mimetype`
 * is copied verbatim from a header the client wrote, so
 * `curl -F "audio=@evil.bin;type=audio/webm"` lies for free.
 *
 * It also does real work beyond rejection. OpenAI's transcription endpoint picks
 * its demuxer from the FILENAME EXTENSION, and the browsers disagree about what
 * they record: Chrome and Firefox produce WebM/Opus, Safari produces MP4/AAC. If
 * the client named the file, a Safari recording mislabelled `.webm` would fail
 * inside OpenAI with an error about a corrupt file — a confusing failure, on the
 * paid call, for something knowable here for free. So the client sends bytes
 * with no name at all and this function is the only thing that decides.
 */
export function sniffAudio(buffer: Buffer): AudioExt | null {
  // Every signature below reads within the first 12 bytes.
  if (buffer.length < 12) return null;

  // EBML header — Matroska, of which WebM is a profile. Chrome, Edge, Firefox.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "webm";
  }

  // ISO base media format: a size field, then "ftyp". Safari on macOS and iOS.
  if (startsWith(buffer, 4, "ftyp")) return "mp4";

  if (startsWith(buffer, 0, "OggS")) return "ogg";

  // RIFF containers are not all audio; the WAVE tag at byte 8 is what narrows it.
  if (startsWith(buffer, 0, "RIFF") && startsWith(buffer, 8, "WAVE")) return "wav";

  return null;
}
