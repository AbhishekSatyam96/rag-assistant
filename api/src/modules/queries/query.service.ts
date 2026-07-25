import { retrieveChunks, type RetrievedChunk } from "../../lib/retrieve";
import { streamAnswer } from "../../lib/answer";

// Orchestration for the RAG read path: retrieve → ground → generate.
//
// The service yields typed EVENTS, not HTTP. It never touches `res`, never
// formats NDJSON, never sets a header. That's deliberate: the transport is the
// most likely thing to change (NDJSON today, SSE or a WebSocket if auth ever
// moves to cookies), and none of that should require reopening the logic that
// decides what an answer is.

// A citation, as the client receives it. This is the contract that makes an
// answer verifiable rather than merely confident.
export type Source = {
  // The 1-based marker the model writes into its prose: "[2]" refers to n === 2.
  // Sent explicitly instead of leaving the client to infer it from array order,
  // so the mapping survives any future reordering or filtering of this list.
  n: number;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  // The chunk text itself, so the UI can show WHAT the answer was drawn from
  // without a follow-up request. Safe to send: retrieval already scoped these
  // rows to this user, so it is their own text coming back to them.
  content: string;
  similarity: number;
};

// A discriminated union — the same pattern as a Redux action or a typed
// postMessage. `type` is the discriminant, so a `switch` on it narrows the
// payload, and adding a new event forces every exhaustive consumer to handle it.
export type QueryEvent =
  // Always first, and emitted BEFORE any token. The UI can render source chips
  // the moment retrieval finishes, which is the part of the wait the user
  // actually feels. It also means a client that only wants citations can read
  // one event and hang up.
  | { type: "sources"; sources: Source[] }
  // One incremental piece of the answer. Called `value` rather than `token`
  // because a delta from the API is not guaranteed to be exactly one token.
  | { type: "token"; value: string }
  // Terminal success. Carries the fully assembled answer so a client that
  // buffered nothing (a test, a curl pipe) still gets the complete text, and so
  // "the stream ended" is distinguishable from "the connection dropped".
  | { type: "done"; answer: string }
  // Terminal failure AFTER streaming began. Once a 200 and the first byte have
  // gone out, the status code is spent — an error can no longer be an HTTP
  // status, so it has to be in-band. See query.routes.ts.
  | { type: "error"; message: string };

function toSource(chunk: RetrievedChunk, index: number): Source {
  return {
    n: index + 1,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    similarity: chunk.similarity,
  };
}

type AnswerQuestionInput = {
  userId: string;
  question: string;
  k: number;
  signal?: AbortSignal;
};

export async function* answerQuestion({
  userId,
  question,
  k,
  signal,
}: AnswerQuestionInput): AsyncGenerator<QueryEvent> {
  // Generator bodies are LAZY: nothing below runs until the caller pulls the
  // first value. The route depends on that — it delays sending response headers
  // until this first yield, so anything that fails during retrieval (a DB
  // outage, an OpenAI 429 while embedding the question) still throws while a
  // real HTTP status code is available. See the comment in query.routes.ts.
  const chunks = await retrieveChunks({ userId, question, k });

  yield { type: "sources", sources: chunks.map(toSource) };

  // Accumulate as we go. The alternative — having the client concatenate and
  // send nothing back — means the server has no record of what it said, which
  // blocks the obvious next features: query history, caching, and an eval
  // harness that scores stored answers.
  let answer = "";

  for await (const value of streamAnswer({ question, chunks, signal })) {
    answer += value;
    yield { type: "token", value };
  }

  yield { type: "done", answer };
}
