"use client";

import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import {
  IconArrowRight,
  IconMic,
  IconSearch,
  IconSpeaker,
  IconSpeakerOff,
  IconStop,
} from "@/components/icons";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { useRecorder } from "@/lib/use-recorder";
import type { SpeechControls } from "@/lib/use-speech";

// The question input, shared by /ask and /chat.
//
// Extracted rather than copied when chat arrived. Everything in here is a small
// correctness detail that took a specific bug to discover — the IME guard, the
// auto-grow reset, the `mt-3` that keeps the icon against the first line — and a
// second copy means the next fix lands in one of them. This is the same argument
// that moved the NDJSON reader into lib/ndjson.ts.
//
// VOICE LIVES HERE, on both halves, because both are properties of the INPUT
// CONTROL rather than of the page around it. Recording produces text that goes
// in this box; the read-aloud switch is a setting about answers you turn on
// while you are asking. Putting either on the page would mean writing it twice,
// which is the thing this file exists to prevent.
//
// The pages keep the half they have to keep: useSpeech lives up there because
// only the page sees the token stream to feed it. This component receives the
// controls and renders the switch.

// Mirrors the server's zod ceiling on `question`. Typing is bounded by the
// textarea's own maxLength, but a TRANSCRIPT is inserted programmatically and
// maxLength does not apply to that — so a two-minute ramble would sail past the
// client check and come back as a 400 the user cannot act on.
const QUESTION_MAX = 1000;

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  // Takes the text as an ARGUMENT rather than letting the parent read its own
  // state. That is what lets a suggestion chip submit in one click: setting
  // state and immediately calling submit would send the previous value, because
  // the update has not reached that closure yet.
  onSubmit: (value: string) => void;
  onStop: () => void;
  streaming: boolean;
  placeholder?: string;
  // Focus on mount. Guarded internally on `(pointer: fine)` — see below.
  autoFocus?: boolean;
  // Presence enables the microphone. It is the auth token, because transcription
  // is an authenticated request; a page that has no token yet simply renders no
  // mic rather than a button that would 401.
  token?: string;
  // Presence enables the read-aloud switch. Optional so a surface that does not
  // stream answers can reuse this component unchanged.
  speech?: SpeechControls;
  className?: string;
};

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  placeholder = "What do your documents say about…?",
  autoFocus = false,
  token,
  speech,
  className,
}: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The transcript is APPENDED, not assigned. Overwriting is the destructive
  // option and it is destructive at the worst moment — someone who typed half a
  // question, then hit the mic to finish it out loud, would watch their typing
  // disappear. Appending is recoverable in a way that clobbering is not.
  const handleTranscript = useCallback(
    (text: string) => {
      const merged = value.trim() ? `${value.trim()} ${text}` : text;
      onChange(merged.slice(0, QUESTION_MAX));
      // Focus lands in the box because the transcript is a DRAFT, not a
      // submission — the cursor sitting in editable text is the affordance that
      // says "check this before sending". See the note in lib/use-recorder.ts
      // about why a misheard word must not go straight to retrieval.
      inputRef.current?.focus();
    },
    [onChange, value],
  );

  const recorder = useRecorder(token, handleTranscript);

  const recording = recorder.state === "recording";
  const busy = recorder.state === "requesting" || recorder.state === "transcribing";
  const micAvailable = Boolean(token) && recorder.supported;

  // Grow the textarea to fit its content.
  //
  // Keyed on `value` rather than done in onChange, because the value also
  // changes programmatically — clicking a suggestion calls onChange from
  // outside, and an onChange-only implementation would leave the box one line
  // tall with the text scrolled out of sight. An effect covers both paths by
  // construction. (A transcript arrives the same way, and gets the same fix for
  // free — which is the payoff for having keyed it on the value in the first
  // place.)
  //
  // `height = "auto"` first is load-bearing: scrollHeight can only report a
  // value at least as large as the current height, so measuring without the
  // reset means the box can grow but never shrink again after a deletion. The
  // 5-line ceiling is CSS (`max-h-34`), not JS — the browser clamps the
  // assignment and hands over a scrollbar, so there is no maximum to keep in
  // sync across two files.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Guarded on `(pointer: fine)` rather than a width breakpoint: what makes
  // autofocus hostile is a virtual keyboard sliding up and eating half the
  // screen before you have read the page, which tracks the input DEVICE, not the
  // viewport. A 1024px-wide tablet is the case a `sm:` check gets wrong.
  useEffect(() => {
    if (!autoFocus) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  // BARGE-IN. Starting the microphone while an answer is being read aloud means
  // recording the answer back through the speakers — getUserMedia's echo
  // cancellation is tuned for a call, not for this, and on a laptop with the
  // volume up it does not save you. Cancelling speech is therefore the first
  // thing recording does, unconditionally, before the permission prompt.
  const startRecording = useCallback(() => {
    speech?.cancel();
    recorder.start();
  }, [recorder, speech]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className={className}
    >
      {/* The input and its button share one bordered container rather than
          sitting side by side with a gap. `focus-within` moves the focus ring to
          that container, so the whole control lights up as a single object —
          which is what it is.

          `items-end`, so that as the textarea grows the button stays pinned to
          the bottom edge next to the last line rather than drifting to the
          vertical middle of a five-line box. */}
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15",
          // Recording is a mode, and a mode the user must never be in without
          // knowing. The border carries it, so the signal is the size of the
          // whole control rather than of one small icon.
          recording && "border-danger ring-4 ring-danger/15",
        )}
      >
        {recording ? (
          // The textarea is REPLACED while recording rather than disabled
          // alongside a separate indicator. A disabled box still looks like
          // somewhere text might appear, and nothing is appearing there yet —
          // this says what is actually happening and where the words will land.
          <div className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2">
            <span className="relative flex size-2.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
            </span>
            <span className="text-[15px] leading-6 text-fg">Listening…</span>
            <span className="text-[13px] tabular-nums text-muted">
              {formatSeconds(recorder.seconds)}
            </span>
          </div>
        ) : (
          <>
            {/* `mt-3` centres the icon against the FIRST line (the 40px row
                minus the 16px icon, halved) instead of letting `items-end` drop
                it to the bottom of a grown box, where it would label nothing. */}
            <IconSearch className="mt-3 ml-2 size-4 shrink-0 self-start text-faint" />
            <textarea
              ref={inputRef}
              rows={1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, Shift+Enter breaks the line — the convention
                // every chat input has trained users into. Without this a
                // textarea silently downgrades the primary action from "press
                // Enter" to "go find the button".
                if (e.key !== "Enter" || e.shiftKey) return;

                // An IME (Japanese, Chinese, Korean) uses Enter to COMMIT the
                // candidate you are picking, and fires keydown for it while
                // composition is still open. Submitting there would send a
                // half-converted question and clear the box mid-word — a bug
                // invisible to anyone testing in English.
                if (e.nativeEvent.isComposing) return;

                e.preventDefault();
                onSubmit(value);
              }}
              placeholder={busy ? "" : placeholder}
              // Mirrors the server's zod ceiling. Client validation here is UX
              // only — it saves a round trip; the server's copy is what is
              // load-bearing. It does NOT bound a transcript, which is inserted
              // programmatically — see handleTranscript.
              maxLength={QUESTION_MAX}
              disabled={streaming}
              aria-label="Your question"
              // `py-2` + `leading-6` makes a single line exactly 40px — the same
              // height as the md Button beside it — so the control does not
              // change shape between the empty state and the first character
              // typed.
              //
              // The border/ring lives on the parent, so this strips its own
              // entirely, including the global :focus-visible outline that would
              // otherwise draw a second ring inside the first.
              className={cn(
                "scrollbar-slim min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6",
                "max-h-34 text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none disabled:text-muted",
              )}
            />
          </>
        )}

        {micAvailable && !streaming && (
          <>
            {recording && (
              // Discard, and it has to exist. Without it the only way out of an
              // accidental recording is to finish it, which spends a paid
              // transcription on a mistake.
              <Button
                onClick={recorder.cancel}
                variant="ghost"
                size="md"
                aria-label="Discard recording"
                title="Discard"
                className="size-10 shrink-0 px-0 text-muted"
              >
                <span aria-hidden className="text-lg leading-none">
                  ×
                </span>
              </Button>
            )}
            <Button
              onClick={recording ? recorder.stop : startRecording}
              variant={recording ? "primary" : "ghost"}
              size="md"
              disabled={busy}
              aria-label={
                recording
                  ? "Stop recording and transcribe"
                  : recorder.state === "transcribing"
                    ? "Transcribing"
                    : "Ask by voice"
              }
              title={recording ? "Stop and transcribe" : "Ask by voice"}
              className="size-10 shrink-0 px-0"
            >
              {recording ? (
                <IconStop className="size-3.5" />
              ) : busy ? (
                <Spinner className="size-4" />
              ) : (
                <IconMic className="size-4.5" />
              )}
            </Button>
          </>
        )}

        {/* Hidden while recording: there is nothing in the box to ask yet, and
            an enabled primary button next to a live microphone is an invitation
            to send an empty question. */}
        {!recording &&
          (streaming ? (
            // Swapping Ask for Stop rather than showing both: while a stream is
            // running, stopping it is the only useful action.
            <Button onClick={onStop} variant="secondary" className="shrink-0">
              <IconStop className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!value.trim() || busy}
              className="shrink-0"
            >
              Ask
              <IconArrowRight className="size-4" />
            </Button>
          ))}
      </div>

      {/* Errors from the microphone belong under the microphone, not in the
          page's error slot — that one is for failed answers, and a denied
          permission prompt has nothing to do with the last question asked.
          `role="status"` rather than "alert": it is worth announcing, and it is
          not an interruption. */}
      {recorder.error && (
        <p role="status" className="mt-2 flex items-start gap-2 px-1 text-[13px] text-danger">
          <span className="flex-1">{recorder.error}</span>
          <button
            type="button"
            onClick={recorder.clearError}
            className="shrink-0 text-muted underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </p>
      )}

      {speech?.supported && (
        <div className="mt-2 flex items-center justify-end gap-3 px-1">
          {speech.speaking && (
            <button
              type="button"
              onClick={speech.cancel}
              className="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Stop reading
            </button>
          )}
          {/* A real toggle the user presses, not a preference that defaults on —
              and that is a technical requirement as much as a courteous one.
              iOS Safari refuses to synthesise speech that was not started from a
              user gesture, and refuses SILENTLY, so the press is what unlocks
              the engine for the rest of the session. See useSpeech's toggle. */}
          <button
            type="button"
            onClick={speech.toggle}
            aria-pressed={speech.enabled}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150",
              speech.enabled ? "text-accent" : "text-muted hover:text-fg",
            )}
          >
            {speech.enabled ? (
              <IconSpeaker className="size-3.5" />
            ) : (
              <IconSpeakerOff className="size-3.5" />
            )}
            Read answers aloud
          </button>
        </div>
      )}
    </form>
  );
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
