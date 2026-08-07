import { toFile } from "openai";
import { openai } from "./openai.js";
import { HttpError } from "./http-error.js";
import type { AudioExt } from "./audio.js";

// Speech to text. Deliberately the ONLY thing in this file: transcription is an
// input adapter, not a stage of the answer pipeline.
//
// WHY THIS IS UPSTREAM OF EVERYTHING AND NOT WIRED INTO IT. The transcript
// becomes the `question` field of an ordinary POST to /queries or
// /conversations, and nothing downstream can tell it came from a microphone.
// That is the whole design: retrieval, generation, the citation rules and the
// eval harness all keep scoring one code path. The same argument that kept
// /queries byte-identical when chat arrived applies here with more force —
// folding speech into the answer route would make hit-rate@k measure
// "transcription + retrieval" while still reading as "retrieval".
//
// It is also why the transcript is handed back to the USER rather than asked
// straight through. A misheard word ("parental leaf") retrieves nothing, the
// grounded prompt then correctly refuses, and the user sees a working system
// insisting their document doesn't say a thing it plainly says. Showing the text
// before it is sent puts the error where it is cheap to fix.

// A constant, not an env var — the opposite call from CHAT_MODEL.
//
// The rule this follows: config is for things a deploy may legitimately vary.
// There is one deployment and no second transcriber to switch to, so an env var
// here would be a configuration surface with no consumer and one more variable
// that can be absent in production. The day there is a real reason to vary it,
// the reason will also say what the default should be.
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/**
 * Transcribe a recording. Returns the trimmed text, never an empty string.
 *
 * `ext` comes from sniffing the bytes (see lib/audio.ts), not from the client:
 * OpenAI selects its demuxer from the filename, so this is the one place that
 * decides what to call the file.
 *
 * `language` is deliberately left unset so the model detects it. Pinning "en"
 * would measurably reduce the silence-hallucination rate, but it would also
 * mean a visitor asking in their own language gets confident nonsense back —
 * and this link is going on a public profile. Auto-detect plus the two size
 * gates in lib/audio.ts is the better trade for who actually visits.
 */
export async function transcribe(
  audio: Buffer,
  ext: AudioExt,
  signal?: AbortSignal,
): Promise<string> {
  // `toFile` wraps the buffer in the Uploadable the SDK wants and — the part
  // that matters — carries the filename through, which is what selects the
  // demuxer on OpenAI's side.
  const file = await toFile(audio, `recording.${ext}`);

  const result = await openai.audio.transcriptions.create(
    { file, model: TRANSCRIBE_MODEL },
    { signal },
  );

  const text = result.text.trim();

  // 422, not 400: the request was well-formed and the audio decoded fine —
  // there was simply nothing said in it. Same status and same reasoning as a
  // scanned PDF with no selectable text.
  //
  // Note what this does NOT catch. An empty transcript is the honest failure; a
  // hallucinated one is the dangerous failure, and it arrives here as ordinary
  // non-empty text with no marker on it. That is a real, known limitation of
  // this model family on near-silent input, and it is bounded on the two sides
  // where bounding is possible — a byte floor here (lib/audio.ts) and a loudness
  // gate in the browser — rather than pretended away with a keyword blocklist,
  // which would be a guess that fails open on every phrase not in it.
  if (!text) {
    throw new HttpError(422, "Nothing was said in that recording. Try again.");
  }

  return text;
}
