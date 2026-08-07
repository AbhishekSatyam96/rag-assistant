import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, sniffAudio } from "./audio.js";

// Free tests: no database, no network, no spend. sniffAudio is the security
// boundary on POST /transcriptions — it is what decides that a claimed
// audio/webm really is one — and it is pure, so there is no excuse for it to be
// the untested part of the route.

// Minimal 12-byte headers. Real files are far longer, but every signature this
// function reads lives in the first 12 bytes, which is the point.
function header(bytes: number[]): Buffer {
  const buffer = Buffer.alloc(12);
  Buffer.from(bytes).copy(buffer);
  return buffer;
}

function ascii(text: string, offset = 0): Buffer {
  const buffer = Buffer.alloc(Math.max(12, offset + text.length));
  buffer.write(text, offset, "latin1");
  return buffer;
}

describe("sniffAudio", () => {
  it("identifies WebM/Matroska by its EBML header", () => {
    assert.equal(sniffAudio(header([0x1a, 0x45, 0xdf, 0xa3])), "webm");
  });

  it("identifies MP4 by `ftyp` at byte 4, not byte 0", () => {
    // Safari records MP4. The first four bytes are a size field with no fixed
    // value, so a check anchored at 0 would reject every Safari recording.
    assert.equal(sniffAudio(ascii("ftyp", 4)), "mp4");
    assert.equal(sniffAudio(ascii("ftyp", 0)), null);
  });

  it("identifies Ogg", () => {
    assert.equal(sniffAudio(ascii("OggS")), "ogg");
  });

  it("requires WAVE at byte 8, not just RIFF", () => {
    // RIFF is a container family, not a format: AVI and WebP are RIFF too.
    const wav = ascii("RIFF");
    wav.write("WAVE", 8, "latin1");
    assert.equal(sniffAudio(wav), "wav");

    const avi = ascii("RIFF");
    avi.write("AVI ", 8, "latin1");
    assert.equal(sniffAudio(avi), null);
  });

  it("rejects a file whose bytes disagree with its claimed type", () => {
    // The case the whole function exists for: `curl -F "audio=@evil.html;
    // type=audio/webm"` sets a content-type the server has no reason to trust.
    assert.equal(sniffAudio(Buffer.from("<!doctype html><html><body>")), null);
  });

  it("rejects a buffer too short to hold any signature", () => {
    // Must not read past the end and must not throw — a truncated upload is a
    // normal event, not an exception.
    assert.equal(sniffAudio(Buffer.alloc(0)), null);
    assert.equal(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), null);
  });
});

describe("audio limits", () => {
  it("keeps the floor below the ceiling, and the ceiling under Vercel's edge", () => {
    // Not a tautology: these two are sized from unrelated things (a container
    // header vs. the cost of a minute of audio), so nothing but a check stops a
    // future edit from crossing them.
    assert.ok(MIN_AUDIO_BYTES < MAX_AUDIO_BYTES);
    // 4.5 MB is where Vercel rejects at the edge, before Express sees the
    // request and before this API can answer in its own `{ error }` shape.
    assert.ok(MAX_AUDIO_BYTES < 4.5 * 1024 * 1024);
  });
});
