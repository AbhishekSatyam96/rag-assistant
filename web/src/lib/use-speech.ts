"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { speakableSentences } from "./speech";

// Reading answers aloud, using the browser's own speechSynthesis.
//
// WHY THE BROWSER AND NOT OPENAI, given the input half of this feature does pay
// for a model. The asymmetry is the decision: a bad transcript silently becomes
// a bad RETRIEVAL, so input quality changes what the system does; a robotic
// voice reading the correct answer is still the correct answer, so output
// quality is cosmetic. Spend money where an error changes the result.
//
// It has three practical consequences worth having: voice output costs nothing,
// adds no route and no rate limiter to a publicly-posted link, and works with
// the network already saturated by the answer stream it is reading.
//
// The runner-up was gpt-4o-mini-tts, which sounds meaningfully better. Revisit
// it if this ever needs to sound good in a recorded demo; not before.

const STORAGE_KEY = "rag.voice";

// --- the persisted on/off preference ---------------------------------------
//
// Same useSyncExternalStore pattern as lib/theme.tsx, for the same reasons:
// localStorage is mutable state outside React, `useState` + a mount effect
// renders once with the wrong value before correcting itself, and the explicit
// server snapshot makes SSR a decision rather than a `window is not defined`
// crash. `storage` only fires in OTHER tabs, so same-tab writes need the manual
// fan-out below.

const listeners = new Set<() => void>();

function subscribeEnabled(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Safari private mode throws outright on localStorage.
    return false;
  }
}

// Off unless asked for. Audio that starts by itself on someone else's machine is
// the kind of default that gets a tab closed.
const serverEnabled = () => false;

// --- support detection ------------------------------------------------------

// A store that never changes, which is exactly what useSyncExternalStore is for
// when the value is simply unavailable during SSR. `supported` cannot be read in
// render (`window` does not exist on the server) and must not be set from an
// effect (React 19's set-state-in-effect rule, and it would render wrong first).
const subscribeNever = () => () => {};
const readSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;
const serverSupported = () => false;

/** Prefer a local voice matching the page language; otherwise let the engine decide. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const lang = (document.documentElement.lang || "en").split("-")[0];
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));

  // Never hardcode a voice by NAME. The inventory differs per OS and per
  // install, so "Samantha" is present on one machine and absent on the next —
  // and a missing named voice falls back silently to whatever is first, which is
  // often a different language.
  return matching.find((v) => v.localService) ?? matching[0] ?? null;
}

export type SpeechControls = {
  supported: boolean;
  enabled: boolean;
  speaking: boolean;
  toggle: () => void;
  /** Stop immediately and drop anything queued. */
  cancel: () => void;
};

export type Speech = SpeechControls & {
  /** Start of a turn: cancel whatever is speaking and reset the sentence counter. */
  reset: () => void;
  /** Feed the accumulated answer so far. Safe to call on every token. */
  push: (answer: string, final: boolean) => void;
};

export function useSpeech(): Speech {
  const supported = useSyncExternalStore(subscribeNever, readSupported, serverSupported);
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, serverEnabled);

  const [speaking, setSpeaking] = useState(false);

  // How many sentences of the current answer have been queued.
  const spokenRef = useRef(0);
  // How much of the answer has been examined, so the segmenter is not re-run for
  // a token that cannot possibly have completed a sentence.
  const seenRef = useRef(0);
  // Outstanding utterances, counted rather than inferred from
  // speechSynthesis.speaking/pending — those two are racy at exactly the moment
  // `onend` fires, which is the moment this needs to be right.
  const outstandingRef = useRef(0);
  // Bumped by cancel(). Handlers from a previous turn check it before touching
  // state, so a late `onend` from a cancelled utterance cannot clear the
  // "speaking" flag of the turn that replaced it.
  const generationRef = useRef(0);

  // getVoices() returns [] on the first call in Chrome and fills in
  // asynchronously. Touching it on mount starts that population early, so the
  // first utterance of the session is more likely to get the intended voice
  // rather than the engine default. Nothing is stored — pickVoice reads live at
  // enqueue time, which is the only moment the answer matters.
  useEffect(() => {
    if (!supported) return;
    window.speechSynthesis.getVoices();
  }, [supported]);

  const cancel = useCallback(() => {
    if (!supported) return;
    generationRef.current += 1;
    outstandingRef.current = 0;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  // Cancel on unmount. Without this, navigating away from a thread mid-answer
  // leaves the browser reading it to an empty room — the audio equivalent of
  // leaving the recording indicator lit.
  useEffect(() => cancel, [cancel]);

  const enqueue = useCallback((text: string) => {
    const generation = generationRef.current;
    const utterance = new SpeechSynthesisUtterance(text);

    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
      // Set together. A voice whose lang disagrees with the utterance's is a
      // reliable way to get an English voice attempting French phonetics.
      utterance.lang = voice.lang;
    }

    const settle = () => {
      if (generation !== generationRef.current) return;
      outstandingRef.current = Math.max(0, outstandingRef.current - 1);
      if (outstandingRef.current === 0) setSpeaking(false);
    };

    utterance.onstart = () => {
      if (generation !== generationRef.current) return;
      setSpeaking(true);
    };
    utterance.onend = settle;
    // A cancelled utterance reports as an error in most engines, which is the
    // only reason the counter does not leak on every Stop.
    utterance.onerror = settle;

    outstandingRef.current += 1;
    window.speechSynthesis.speak(utterance);
  }, []);

  const reset = useCallback(() => {
    spokenRef.current = 0;
    seenRef.current = 0;
    cancel();
  }, [cancel]);

  // `enabled` is read as an ordinary dependency rather than through a ref, which
  // means flipping the toggle rebuilds this callback. That is the behaviour you
  // want, not a cost: ChatView captures `push` when a turn starts, so switching
  // voice on mid-answer takes effect from the NEXT question instead of suddenly
  // reading the current one aloud from its first sentence — which is what a ref
  // would have done, because the sentence counter is still at zero.
  const push = useCallback(
    (answer: string, final: boolean) => {
      if (!supported || !enabled) return;

      // Everything that has arrived since the last time this did real work. It
      // keeps growing across early returns, so a sentence terminator is never
      // missed by being split across two ticks.
      const tail = answer.slice(seenRef.current);
      if (!final && !/[.!?:;\n]/.test(tail)) return;

      seenRef.current = answer.length;

      const { sentences, spoken } = speakableSentences(answer, spokenRef.current, final);
      spokenRef.current = spoken;
      for (const sentence of sentences) enqueue(sentence);
    },
    [supported, enabled, enqueue],
  );

  const toggle = useCallback(() => {
    const next = !enabled;

    if (!next) cancel();

    if (next && supported) {
      // iOS Safari will not speak unless synthesis has been started from inside
      // a user gesture, and it fails SILENTLY — speak() resolves, nothing is
      // heard, and there is no error to catch. This click IS that gesture, but
      // the first real sentence arrives seconds later on a network callback,
      // which is not. Speaking an empty utterance here unlocks the engine while
      // the gesture is still on the stack, and makes no sound.
      //
      // It is also why this has to be a button the user presses rather than a
      // preference that defaults on: there would be no gesture to unlock it with.
      try {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
      } catch {
        // Some engines reject an empty utterance. Losing the unlock is a
        // degraded feature; throwing here would take the toggle with it.
      }
    }

    try {
      // Absence means off, so nothing is written for the default state — same
      // convention as theme.tsx storing "system" as a missing key.
      if (next) localStorage.setItem(STORAGE_KEY, "on");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode. The toggle still applies for this page; it just will not
      // be remembered.
    }

    listeners.forEach((listener) => listener());
  }, [cancel, enabled, supported]);

  // Memoised, and load-bearing. ChatView's `ask` lists what it closes over in a
  // dependency array that was deliberately kept free of anything changing per
  // keystroke; returning a fresh object literal here would rebuild `ask` on
  // every render and quietly undo that.
  return useMemo(
    () => ({ supported, enabled, speaking, toggle, cancel, reset, push }),
    [supported, enabled, speaking, toggle, cancel, reset, push],
  );
}
