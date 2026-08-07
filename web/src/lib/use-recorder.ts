"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, transcribeAudio } from "./api";

// Recording a question and turning it into text.
//
// THE TRANSCRIPT GOES INTO THE COMPOSER, NOT INTO A REQUEST. That is the whole
// design decision and it is worth stating plainly: a misheard word ("parental
// leaf" for "parental leave") retrieves nothing, the grounded prompt then
// correctly refuses, and the user watches a working system insist their document
// does not say a thing it plainly says. A correct system producing a broken
// product — the same failure the NO_SEARCH sentinel exists to prevent on the
// server. Handing the text back for a glance is where that error is cheap.

/** How long a single recording may run before it stops itself. */
const MAX_SECONDS = 60;

/**
 * Peak amplitude, 0–1, below which a recording is treated as silence.
 *
 * Transcription models in this family HALLUCINATE on silence — a clip of room
 * tone comes back as fluent text ("Thank you.") which then flows into retrieval
 * as if it had been asked. The server has a byte floor for the empty case, but
 * three seconds of a quiet room is a perfectly large file; only the decoded
 * samples can tell the difference, and the browser is the only side that has
 * them. So the check belongs here, and it is the reason this hook opens an
 * AudioContext at all.
 *
 * Peak rather than average, because a short question is mostly gaps between
 * words and an averaged measure of real speech sits surprisingly close to
 * silence. 0.02 is roughly "a microphone that is switched on and pointed at
 * someone" — high enough to catch a muted input, low enough not to reject a
 * quiet speaker.
 */
const SILENCE_PEAK = 0.02;

// Ordered by preference. Chrome, Edge and Firefox take the first; Safari on
// macOS and iOS falls through to audio/mp4. An empty return lets the browser
// pick its own default, which is better than refusing to record.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

function pickMimeType(): string | undefined {
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

// Recording is unavailable on the server, and on any page not served over HTTPS
// (localhost excepted) — `navigator.mediaDevices` is simply absent in an
// insecure context, which is why this is a support check and not a permission
// error. Same useSyncExternalStore-over-a-constant approach as useSpeech: the
// value cannot be read during render and must not be set from an effect.
const subscribeNever = () => () => {};
const readSupported = () =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;
const serverSupported = () => false;

// A state machine, not a set of booleans. Two of these can look alike from the
// outside and need completely different UI — "requesting" is a browser
// permission prompt the user has to answer, "transcribing" is a network wait —
// and with booleans the impossible combinations are one bug away.
export type RecorderState = "idle" | "requesting" | "recording" | "transcribing";

export type Recorder = {
  supported: boolean;
  state: RecorderState;
  /** Seconds elapsed in the current recording, for the timer readout. */
  seconds: number;
  error: string | null;
  start: () => void;
  /** Finish and transcribe. */
  stop: () => void;
  /** Throw the recording away, or abort an in-flight transcription. */
  cancel: () => void;
  clearError: () => void;
};

function permissionMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // Distinct from "no microphone" on purpose: this one is fixable by the
      // user, and only if they are told where to look.
      return "Microphone access was blocked. Allow it in your browser's site settings and try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found.";
    case "NotReadableError":
      return "Your microphone is in use by another app.";
    default:
      return "Couldn't start recording.";
  }
}

export function useRecorder(
  token: string | undefined,
  onTranscript: (text: string) => void,
): Recorder {
  const supported = useSyncExternalStore(subscribeNever, readSupported, serverSupported);

  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const peakRef = useRef(0);
  const meterRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  // Set by cancel() before stop(), because `onstop` is where the blob is built
  // and it has no other way to know it should be discarded.
  const discardRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Read inside onTranscript's call site, which runs from a MediaRecorder event
  // rather than a render — so the value has to be the current one, not the one
  // captured when recording started.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // RELEASING THE TRACKS IS NOT OPTIONAL. Stopping the MediaRecorder leaves the
  // MediaStream open, and an open stream keeps the browser's recording indicator
  // lit and the OS microphone light on — after the user believes they have
  // stopped. That reads as spyware, and it is the single most important line in
  // this file.
  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    // AudioContexts are a limited per-page resource; leaking one per recording
    // means a long session eventually cannot open another.
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    if (meterRef.current !== null) window.clearInterval(meterRef.current);
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    meterRef.current = null;
    timerRef.current = null;
    deadlineRef.current = null;
    recorderRef.current = null;
  }, []);

  // Stop everything on unmount: navigating away mid-recording must not leave the
  // microphone open, and must not leave a transcription in flight that resolves
  // into a component that no longer exists.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      abortRef.current?.abort();
      try {
        recorderRef.current?.stop();
      } catch {
        // Already inactive; teardown below is what actually matters.
      }
      teardown();
    };
  }, [teardown]);

  const start = useCallback(() => {
    if (!supported || !tokenRef.current) return;
    if (recorderRef.current) return;

    setError(null);
    setSeconds(0);
    setState("requesting");
    discardRef.current = false;
    chunksRef.current = [];
    peakRef.current = 0;

    // getUserMedia's three hints are all worth asking for. Echo cancellation in
    // particular is the difference between a usable feature and one that records
    // the answer being read aloud through the speakers — the composer also
    // cancels speech before calling this, but a laptop with the volume up is
    // exactly the setup where belt and braces earns its keep.
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((stream) => {
        streamRef.current = stream;

        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };

        recorder.onstop = () => {
          // The recorder's own mimeType, not the requested one: the browser is
          // allowed to hand back something else, and building a Blob with a
          // type it does not have would be a lie the server has to catch.
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || mimeType || "audio/webm",
          });
          const peak = peakRef.current;

          teardown();
          chunksRef.current = [];

          if (discardRef.current) {
            setState("idle");
            setSeconds(0);
            return;
          }

          setSeconds(0);

          if (peak < SILENCE_PEAK) {
            setState("idle");
            setError("That recording was silent. Check your microphone and try again.");
            return;
          }

          const activeToken = tokenRef.current;
          if (!activeToken) {
            setState("idle");
            return;
          }

          setState("transcribing");
          const controller = new AbortController();
          abortRef.current = controller;

          transcribeAudio(activeToken, blob, controller.signal)
            .then((text) => {
              // Straight into the composer, not into a question. See the note at
              // the top of this file.
              onTranscriptRef.current(text);
              setState("idle");
            })
            .catch((err: unknown) => {
              if (err instanceof DOMException && err.name === "AbortError") {
                setState("idle");
                return;
              }
              setError(
                err instanceof ApiError ? err.message : "Couldn't transcribe that.",
              );
              setState("idle");
            })
            .finally(() => {
              abortRef.current = null;
            });
        };

        // The loudness meter. An AnalyserNode reading the live stream, sampled
        // on an interval rather than in a requestAnimationFrame loop — rAF is
        // throttled to a crawl in a background tab, which is a state a recording
        // can perfectly well be in.
        try {
          const context = new AudioContext();
          audioContextRef.current = context;
          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          context.createMediaStreamSource(stream).connect(analyser);

          const samples = new Uint8Array(analyser.fftSize);
          meterRef.current = window.setInterval(() => {
            analyser.getByteTimeDomainData(samples);
            let peak = 0;
            for (const sample of samples) {
              // Byte-domain data is centred on 128; deviation from it is
              // amplitude.
              const amplitude = Math.abs(sample - 128) / 128;
              if (amplitude > peak) peak = amplitude;
            }
            if (peak > peakRef.current) peakRef.current = peak;
          }, 100);
        } catch {
          // No AudioContext means no silence gate. Fail OPEN — recording still
          // works, the server's byte floor still applies, and refusing to record
          // because we cannot measure loudness would trade a real feature for a
          // guard against a rarer failure.
          peakRef.current = 1;
        }

        const startedAt = Date.now();
        deadlineRef.current = startedAt + MAX_SECONDS * 1000;

        timerRef.current = window.setInterval(() => {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          setSeconds(elapsed);

          // The cap is enforced here rather than with a single setTimeout so it
          // cannot be missed if the tab is throttled: any tick past the deadline
          // ends the recording. It bounds what a single request can cost, which
          // is the half of the cost story a request-counting rate limiter cannot
          // do.
          if (deadlineRef.current !== null && Date.now() >= deadlineRef.current) {
            try {
              recorderRef.current?.stop();
            } catch {
              // Already stopped.
            }
          }
        }, 250);

        recorder.start();
        setState("recording");
      })
      .catch((err: unknown) => {
        teardown();
        setState("idle");
        setError(permissionMessage(err));
      });
  }, [supported, teardown]);

  const stop = useCallback(() => {
    if (!recorderRef.current) return;
    try {
      recorderRef.current.stop();
    } catch {
      // Racing a self-stop at the duration cap. onstop has already run.
    }
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;

    // Two different things to cancel depending on where we are, and both are
    // reachable from the same button.
    abortRef.current?.abort();

    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch {
        teardown();
        setState("idle");
      }
      return;
    }

    setState("idle");
  }, [teardown]);

  const clearError = useCallback(() => setError(null), []);

  return { supported, state, seconds, error, start, stop, cancel, clearError };
}

export { MAX_SECONDS as MAX_RECORDING_SECONDS };
