// Turning the model's inline "[2]" markers into structured segments.
//
// Extracted from AnswerView.tsx when chat arrived and a second component needed
// it. That move also fixes a gap STATUS.md called out: this is the logic most
// likely to break, and it was living inside a component in a package with no
// test runner, so the claim that it was covered was false. As a plain module it
// is importable by a test the day `web` gets one.

const CITATION = /\[(\d+)\]/g;

export type Segment =
  | { kind: "text"; value: string }
  | { kind: "citation"; n: number };

// Split "runs first [2] and then [3]" into alternating text/citation segments.
//
// Called at RENDER time on the accumulated answer, not once when the stream
// finishes. That matters because the text grows token by token: a marker may
// briefly arrive as "[", then "[1", then "[1]". Re-deriving from the current
// string on each render means a half-typed marker simply displays as the literal
// characters it currently is, and becomes a chip the instant it completes. The
// alternative — parsing incrementally with a cursor — has to handle that
// partial state explicitly, for no benefit.
export function parseCitations(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  // `matchAll` rather than a `while (exec())` loop: exec on a /g regex mutates
  // `lastIndex` on the shared regex object, so a module-level regex used that
  // way carries state between calls and skips matches on every other render. A
  // genuinely nasty bug, and one a streaming component would hit constantly.
  for (const match of text.matchAll(CITATION)) {
    const index = match.index;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({ kind: "citation", n: Number(match[1]) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return segments;
}
