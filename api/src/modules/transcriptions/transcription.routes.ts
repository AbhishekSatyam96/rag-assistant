import { Router } from "express";
import multer from "multer";
import { HttpError } from "../../lib/http-error.js";
import { MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, sniffAudio } from "../../lib/audio.js";
import { transcribe } from "../../lib/transcribe.js";
import {
  audioBurstLimiter,
  audioDailyLimiter,
  globalAudioLimiter,
} from "../../middleware/rate-limit.js";

// POST /transcriptions — one recording in, one string out.
//
// A resource of its own rather than a flag on the answer routes. The two are
// separate requests because they are separate decisions: this one produces text
// the USER then reads, edits if the transcriber misheard, and only then submits.
// Chaining them server-side would save a round trip and remove the only point at
// which a wrong transcript is visible before it becomes a wrong retrieval.
//
// Mounted behind requireAuth in app.ts. Nothing is persisted — the audio lives in
// this process's memory for the length of one request and the text goes back on
// the wire. There is no Recording table and there should not be one: keeping
// voice recordings of strangers who clicked a link on LinkedIn is a data
// liability with no feature behind it.
export const transcriptionRouter = Router();

// memoryStorage for the same reason as the PDF route: the bytes exist only long
// enough to become text, nothing serves them back, and there are no temp files
// to clean up on the failure paths. Justified precisely because `fileSize`
// bounds how much memory that can be.
//
// AND THIS IS THE ONLY LIMIT THAT APPLIES. `express.json({ limit: "1mb" })` in
// app.ts is content-type-gated — it sees multipart/form-data and calls next()
// without reading a byte — so assuming the global JSON cap also covers this
// route means shipping an unbounded upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 2 },
});

// The three limiters run BEFORE multer, so a rate-limited caller is rejected
// without us first accepting and buffering a megabyte from them. Order matches
// /queries: burst, then the per-user budget it must not spend, then the shared
// one — see the note on their definitions.
//
// `answerConcurrency` is deliberately NOT here. It exists to bound simultaneous
// STREAMS, which hold an expensive resource open for seconds; this is a short
// request/response that resolves in about a second and holds nothing. Adding it
// would make a recording compete for slots with the answers it is trying to ask
// for.
transcriptionRouter.post(
  "/",
  audioBurstLimiter,
  audioDailyLimiter,
  globalAudioLimiter,
  upload.single("audio"),
  async (req, res) => {
    // multer leaves `req.file` undefined for a missing or misnamed field rather
    // than erroring, so without this check it surfaces as a TypeError and a 500.
    if (!req.file) {
      throw new HttpError(400, "No audio uploaded. Send it as the `audio` field.");
    }

    const buffer = req.file.buffer;

    // Ordered cheapest-first, and the size floor runs before the sniff because
    // a truncated recording would fail the sniff with a message about the
    // format, sending the user to fix the wrong thing.
    if (buffer.length < MIN_AUDIO_BYTES) {
      throw new HttpError(400, "That recording is too short to contain anything.");
    }

    // Content-type is a claim; the leading bytes are evidence. See lib/audio.ts
    // for why the answer also decides the filename we hand to OpenAI.
    const ext = sniffAudio(buffer);
    if (!ext) {
      throw new HttpError(
        400,
        "That doesn't look like an audio recording this API can read.",
      );
    }

    // Wired from the socket closing to the OpenAI request, the same as the
    // streaming routes: a user who cancels a recording mid-upload should not
    // leave us paying for a transcription nobody will read.
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const text = await transcribe(buffer, ext, controller.signal);

    res.json({ text });
  },
);
