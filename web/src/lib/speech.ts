// Turning a streamed answer into something worth listening to.
//
// SPEECH IS A DIFFERENT PROJECTION OF THE ANSWER THAN DISPLAY. That framing is
// borrowed directly from the api's `toHistory`, where a transcript and a prompt
// are two projections of the same message rows: same source, different
// audiences, different rules. Here the source is one answer string, and the two
// consumers want opposite things from it.
//
// What display wants and speech does not:
//   - "[2]" — the marker that makes AnswerView render a clickable chip. Read
//     aloud it is "bracket two", which is noise. Nothing is lost by dropping it,
//     because the cited text is on screen WHILE it is being spoken; the citation
//     changes modality rather than disappearing.
//   - markdown — the model emits `**bold**`, backticks and bullets. Several
//     synthesis engines read those characters out literally.
//
// The sibling of parseCitations in lib/citations.ts, and kept in its own file
// rather than added there: that module is about the [n] markers specifically,
// this one is about everything that makes a string speakable. Both are pure and
// both are importable by a test the day `web` gets a runner.

const CITATION = /\[\d+\]/g;

/** Strip the answer down to the words, in the order a listener should hear them. */
export function toSpeech(text: string): string {
  const stripped = text
    // Fenced code first, so nothing below has to survive its contents. Dropped
    // entirely rather than read: a shell command spelled out character by
    // character is unusable as audio, and the block is on screen for anyone who
    // wants it.
    .replace(/```[\s\S]*?```/g, " ")
    // Inline code keeps its CONTENTS and loses its backticks. `chunkSize` is a
    // word the sentence is making a point about; the backticks are punctuation.
    .replace(/`([^`\n]+)`/g, "$1")
    // Links and images keep the label and lose the URL. A spoken https:// is
    // the single worst thing a synthesizer can be handed.
    .replace(/!?\[([^\]\n]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(CITATION, "")
    // Emphasis, matched as a PAIR. Matching the characters individually would
    // mean a half-arrived "**bol" loses its opener and can never re-pair when
    // the rest of the token lands — see the note about re-deriving, below.
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*(?!\s)([^*\n]+?)\*/g, "$1");

  return (
    stripped
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s{0,3}>\s?/, "")
          // Bullet and ordered-list markers. Replaced by nothing rather than by
          // a pause — the per-line full stop added below is the pause.
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
          // Anything left of an unmatched pair. Safe only because this function
          // always runs on the WHOLE accumulated answer (never on its own
          // output), so removing a stray opener now cannot stop the completed
          // pair from matching on the next tick.
          .replace(/[*`]+/g, "")
          .replace(/[ \t]+/g, " ")
          // "…the handbook [1]." has just lost its marker and been left with a
          // space in front of the full stop.
          .replace(/\s+([.,;:!?])/g, "$1")
          .trim(),
      )
      // Blank lines and horizontal rules.
      .filter((line) => line.length > 0 && !/^[-*_\s]{3,}$/.test(line))
      // A NEWLINE IN PROSE IS NOT A SENTENCE BOUNDARY; A NEWLINE IN A LIST IS.
      // The bullet markers came off two steps ago, so a list arrives here as
      // consecutive lines with no terminal punctuation — which the segmenter
      // below correctly reads as ONE enormous sentence, and which
      // speechSynthesis then reads as one enormous utterance. That is both a bad
      // listen (no pauses between items) and the exact shape of the Chrome bug
      // that truncates long utterances. Giving every unterminated line a full
      // stop makes each item its own utterance and its own beat.
      //
      // It does mean the spoken text contains punctuation the printed text does
      // not. That is what "different projection" buys, and it is the right call:
      // the alternative is faithful and unlistenable.
      .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
      .join(" ")
      .trim()
  );
}

// Intl.Segmenter over a hand-rolled regex, and this is not a style preference.
// Splitting on /[.!?]\s/ breaks on "e.g.", on decimals like the 0.33 similarity
// this app displays, and on "lib/answer.ts" — and since the corpus IS this
// repo's own documentation, answers are full of filenames and version numbers.
// A pause in the middle of a filename on every single answer is the failure mode.
//
// Constructed once at module scope: it is stateless and building one per call
// would be the expensive part of this file. Guarded because Firefox only shipped
// it in 125, and a browser without it should lose sentence quality, not audio.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : null;

// Abbreviations the segmenter breaks after and should not.
//
// Intl.Segmenter handles "lib/answer.ts" and "0.33" correctly — no whitespace
// follows the dot, so no sentence-break context exists — but "e.g. PDFs" has
// both a space and a capital after it and looks exactly like a boundary. This
// was found by feeding it real sentences, not by reasoning about it, and the
// consequence is only prosodic: nothing is lost or spoken twice, there is just a
// wrong pause in the middle of a sentence. Worth fixing anyway, because this
// corpus is technical prose and "e.g." is in it constantly.
//
// A CLOSED LIST, not a heuristic like "a short lowercase token before a dot".
// The heuristic would be shorter and would break the two cases that already
// work. Note what is deliberately absent: "etc.", which genuinely does end
// sentences, so merging after it would join two real sentences into one — a
// worse error than the pause this is fixing.
const NEVER_ENDS_A_SENTENCE = /(?:^|[\s(])(?:e\.g|i\.e|cf|vs|approx|Dr|Mr|Mrs|Ms|Prof|St|Fig)\.$/;

function mergeAbbreviations(segments: string[]): string[] {
  const merged: string[] = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && NEVER_ENDS_A_SENTENCE.test(previous)) {
      // The segments were trimmed, so the separator has to be put back.
      merged[merged.length - 1] = `${previous} ${segment}`;
    } else {
      merged.push(segment);
    }
  }

  return merged;
}

export function segmentSentences(text: string): string[] {
  if (!text.trim()) return [];

  if (segmenter) {
    const raw = [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
    return mergeAbbreviations(raw);
  }

  // The fallback, written without a lookbehind so it stays legal under the
  // ES2017 target in tsconfig.json. Consumes a run of non-terminators plus
  // whatever terminators follow it; the final alternative catches a trailing
  // fragment with no terminator at all.
  const raw = (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);

  return mergeAbbreviations(raw);
}

/**
 * Which sentences of a still-growing answer are safe to speak now.
 *
 * THIS IS THE NDJSON LINE BUFFER AGAIN, one layer up. A network chunk respects
 * no line boundary, so lib/ndjson.ts buffers and flushes only complete lines; a
 * token respects no sentence boundary, so this flushes only complete sentences
 * and holds the remainder. Same shape, same reason, and the same failure if you
 * skip it: it works perfectly on short answers and mangles long ones.
 *
 * THE LAST SEGMENT IS ALWAYS HELD BACK while `final` is false, even when it
 * already ends in a full stop — that is what makes the whole thing safe. A
 * buffer ending "…in v1." looks finished; the next token may be "5, released…",
 * at which point the segmenter revises the boundary it had drawn. Since the
 * revision can only ever touch the tail, never speaking the tail means never
 * speaking a sentence that later turns out to be half of one.
 *
 * `alreadySpoken` is a COUNT of segments rather than a character offset, because
 * offsets into the raw answer do not map onto the projected text (toSpeech
 * changes lengths). Counting works because everything before the held-back tail
 * is stable.
 *
 * Called with the full accumulated answer each time — deliberately, and for the
 * same reason parseCitations re-derives on every render instead of parsing
 * incrementally: the alternative needs explicit partial-state handling for no
 * gain. Re-projecting a 2 KB string is cheap, and useSpeech only calls this when
 * new text has actually arrived that might have completed a sentence.
 */
export function speakableSentences(
  answer: string,
  alreadySpoken: number,
  final: boolean,
): { sentences: string[]; spoken: number } {
  const all = segmentSentences(toSpeech(answer));
  const available = final ? all : all.slice(0, -1);

  if (available.length <= alreadySpoken) return { sentences: [], spoken: alreadySpoken };

  return { sentences: available.slice(alreadySpoken), spoken: available.length };
}
