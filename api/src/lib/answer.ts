import { openai } from "./openai.js";
import { env } from "./env.js";
import type { RetrievedChunk } from "./retrieve.js";

// Generation: retrieved chunks in, a grounded answer out, streamed token by
// token.
//
// This file knows nothing about HTTP. It yields strings; whoever calls it
// decides whether those become an NDJSON stream, a WebSocket frame, or a single
// concatenated string in a test. That boundary is what makes the answer logic
// testable without booting a server — the same reason the service layer doesn't
// import `express`.

// Temperature 0. This is a grounded-QA task, not writing: every degree of
// creativity here is a degree of freedom to invent something the sources don't
// say. It also makes the eval harness (next milestone) meaningful — a
// non-deterministic model makes a regression indistinguishable from noise.
const TEMPERATURE = 0;

// The exact sentence the model must emit when the context doesn't answer the
// question. Specified verbatim rather than left to the model's judgement,
// because "say you don't know" produces a different apology every time; a fixed
// string is something the UI can detect and the eval harness can assert on.
export const REFUSAL = "I don't have enough information in your documents to answer that.";

// Sources are numbered from 1, not 0 — these markers are written by the model
// into prose a human reads, and "[0]" reads like a typo. The UI maps marker n
// back to `sources[n - 1]`; that off-by-one lives in exactly one place (the
// frontend renderer) rather than being re-derived at each call site.
export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] (from "${c.documentTitle}", chunk ${c.chunkIndex})\n${c.content}`,
    )
    .join("\n\n---\n\n");
}

// Everything the model is told about how to behave. Written as a constant, not
// interpolated inline, because prompts are the highest-churn part of a RAG app
// and they deserve to be diffable in code review like any other logic.
//
// Each rule is here for a specific failure this prompt is defending against:
//   1 & 2 — the model answering from pretraining. It knows plenty about most
//           topics; the entire value of RAG is that it answers from YOUR data,
//           and a plausible answer from the wrong source is worse than none.
//   3     — uncited claims. If it isn't traceable to a chunk, the user has no
//           way to verify it, and "grounded with citations" becomes decoration.
//   4     — hedging. Without a fixed refusal string the model waffles, and a
//           waffle is indistinguishable from a weak answer.
//   5     — the "helpful" instinct to fill gaps with adjacent context.
const SYSTEM_PROMPT = `You are a precise question-answering assistant for a personal document library.

Rules:
1. Answer ONLY from the numbered sources provided in the user message. They are your single source of truth.
2. Never use knowledge from your training data. If you know the answer but the sources do not state it, you must treat it as unknown.
3. Cite every claim inline with the source number in square brackets, e.g. "the retriever runs first [2]". Cite multiple sources as [1][3] when a claim draws on several.
4. If the sources do not contain enough information to answer, reply with EXACTLY this sentence and nothing else: "${REFUSAL}"
5. Do not speculate, do not extrapolate beyond the sources, and do not pad the answer with general background.
6. Be concise and direct. Prefer short paragraphs or bullets over preamble.`;

type StreamAnswerInput = {
  question: string;
  chunks: RetrievedChunk[];
  // Lets the caller cancel generation when the HTTP client disconnects. Without
  // it, a user closing the tab leaves us streaming tokens from OpenAI into a
  // socket nobody is reading — billed in full, to nobody's benefit.
  signal?: AbortSignal;
};

// An async generator rather than a callback or an EventEmitter: `for await
// (const token of streamAnswer(...))` reads like a loop over an array, and
// backpressure, early `break`, and error propagation all work the way normal
// control flow does. The closest frontend analogy is an async iterator over a
// ReadableStream — same shape, same reason.
export async function* streamAnswer({
  question,
  chunks,
  signal,
}: StreamAnswerInput): AsyncGenerator<string> {
  // Short-circuit with no model call at all when retrieval found nothing. The
  // model cannot answer from an empty context, so asking it to is a guaranteed
  // refusal that costs a network round-trip and real money. Emitting the exact
  // same REFUSAL string keeps the two paths indistinguishable to the client.
  if (chunks.length === 0) {
    yield REFUSAL;
    return;
  }

  // Context BEFORE the question. Two reasons: models attend most reliably to
  // the start and end of a prompt, so the question landing last keeps it in the
  // strongest position; and a stable prefix is what makes prompt caching
  // possible later, since caching keys on a shared leading substring.
  const userPrompt = `Sources:\n\n${formatContext(chunks)}\n\n---\n\nQuestion: ${question}`;

  const stream = await openai.chat.completions.create(
    {
      model: env.CHAT_MODEL,
      temperature: TEMPERATURE,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    },
    { signal },
  );

  for await (const part of stream) {
    // Not every chunk carries text: the first one usually announces the role,
    // and the last carries only a finish_reason. Optional-chaining the whole
    // path rather than indexing blindly, because `choices` can be an empty
    // array on some events and `choices[0].delta` would throw.
    const delta = part.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
