import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { SignJWT } from "jose";

import { createApp } from "./app.js";
import { signToken } from "./lib/jwt.js";

// HTTP-level tests that deliberately touch NO external service.
//
// Everything asserted here resolves before the first database query and before
// any OpenAI call: rejections from requireAuth, from the body parser, and from
// Express's own routing. That is what keeps this tier free, fast, and safe to
// run on every commit — the moment a test needs a real row, it belongs in the
// integration tier instead.
//
// Note what is NOT mocked: no fake Express, no stubbed middleware. This is the
// real app object from createApp(), with the real middleware chain in the real
// order, which is the only version where an ordering bug can actually show up.
// (createApp is exported for exactly this — app.ts also constructs a default
// instance at module load for the deployment entrypoint, and reusing that one
// would share rate-limiter state between test files.)

const app = createApp();

// Every route that must never be reachable without a verified token. Kept as
// data so adding a protected route means adding one line here, and so a
// regression names the exact route in the failure output.
const PROTECTED = [
  { method: "get", path: "/me" },
  { method: "get", path: "/documents" },
  { method: "get", path: "/documents/some-id" },
  { method: "post", path: "/documents" },
  { method: "post", path: "/documents/upload" },
  { method: "post", path: "/queries" },
  { method: "post", path: "/transcriptions" },
] as const;

describe("authentication guard", () => {
  for (const route of PROTECTED) {
    it(`401s ${route.method.toUpperCase()} ${route.path} with no Authorization header`, async () => {
      const res = await request(app)[route.method](route.path).send({});

      assert.equal(res.status, 401);
      // The uniform error envelope. Every failure in this app arrives as
      // `{ error }` — including 429s, which are routed through the same
      // handler rather than express-rate-limit's own response writer — so the
      // web client needs exactly one branch to render any of them.
      assert.equal(typeof res.body.error, "string");
    });
  }

  it("401s a malformed Authorization header", async () => {
    // Not "Bearer <token>". The guard checks the scheme before it checks the
    // token, so this never reaches jose.
    const res = await request(app).get("/me").set("Authorization", "some-token");

    assert.equal(res.status, 401);
  });

  it("401s a token signed with the wrong secret", async () => {
    // The forgery case, and the reason HS256 + a server-held secret is the
    // whole security model: the claims are readable by anyone, but unforgeable
    // without JWT_SECRET. A token that is structurally perfect and signed by
    // someone else must be indistinguishable from garbage.
    const forged = await new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("some-user-id")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-completely-different-secret-of-length-32"));

    const res = await request(app).get("/me").set("Authorization", `Bearer ${forged}`);

    assert.equal(res.status, 401);
  });

  it("401s an expired token", async () => {
    // Signed with the REAL secret, so only the expiry claim rejects it. This is
    // the test that would catch someone dropping expiry verification while
    // "simplifying" verifyToken.
    const expired = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-id")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));

    const res = await request(app).get("/me").set("Authorization", `Bearer ${expired}`);

    assert.equal(res.status, 401);
  });

  it("admits a valid token and echoes the claims back", async () => {
    // GET /me reads req.user straight off the verified token and never queries
    // the database, which is what makes this assertable in the unit tier — and
    // is also the point of the route: it proves the middleware end to end.
    // `sub`, not `id` — the token carries the JWT-standard subject claim, and
    // requireAuth is what renames it to `req.user.id`.
    const token = await signToken({ sub: "user-123", email: "user@example.com" });

    const res = await request(app).get("/me").set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, { id: "user-123", email: "user@example.com" });
  });
});

describe("body parsing", () => {
  it("400s malformed JSON with the standard error envelope", async () => {
    // Body-parser failures are neither ZodError nor HttpError, so before
    // middleware/error.ts grew an explicit branch for them they fell through as
    // a bare 500 — a client bug reported as a server fault.
    const res = await request(app)
      .post("/auth/signup")
      .set("Content-Type", "application/json")
      .send('{"email": "broken",');

    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, "string");
  });

  it("413s a body over the 1mb limit, before authentication runs", async () => {
    // express.json() is mounted app-wide, so it runs ahead of requireAuth. An
    // oversized body therefore gets 413 rather than 401 even on a protected
    // route — worth pinning, because the intuitive expectation is the opposite
    // and someone reordering the middleware would silently change it.
    const oversized = JSON.stringify({ title: "T", content: "x".repeat(1_200_000) });

    const res = await request(app)
      .post("/documents")
      .set("Content-Type", "application/json")
      .send(oversized);

    assert.equal(res.status, 413);
    assert.equal(typeof res.body.error, "string");
  });
});

// POST /transcriptions — every rejection that happens BEFORE the paid call.
//
// That boundary is the whole reason these belong in the free tier: the route is
// deliberately built so that a missing file, a recording too short to hold
// speech, and bytes that are not audio at all are all decided from the request
// itself. Nothing here opens a socket to OpenAI, and if one of these ever starts
// to, this suite will hang and say so.
describe("POST /transcriptions validation", () => {
  let token: string;

  before(async () => {
    token = await signToken({ sub: "user-123", email: "user@example.com" });
  });

  it("400s a request with no file attached", async () => {
    // multer leaves req.file undefined for a missing or misnamed field rather
    // than erroring, so without the explicit check this is a TypeError and a 500.
    const res = await request(app)
      .post("/transcriptions")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, "string");
  });

  it("400s a file on the wrong field name", async () => {
    const res = await request(app)
      .post("/transcriptions")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.alloc(4096), "recording.webm");

    assert.equal(res.status, 400);
  });

  it("400s a recording too short to contain speech", async () => {
    // A valid WebM header and nothing else — the shape a click on the mic
    // button produces. Rejected on size before the sniff, so the message talks
    // about length rather than sending the user to fix the format.
    const stub = Buffer.alloc(512);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(stub);

    const res = await request(app)
      .post("/transcriptions")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", stub, "recording.webm");

    assert.equal(res.status, 400);
    assert.match(res.body.error, /short/i);
  });

  it("400s bytes that are not audio, whatever the content-type claims", async () => {
    // The forged-content-type case. Large enough to clear the size floor, so
    // the only thing that can reject it is the magic-byte check.
    const res = await request(app)
      .post("/transcriptions")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", Buffer.alloc(8192, 0x41), {
        filename: "recording.webm",
        contentType: "audio/webm",
      });

    assert.equal(res.status, 400);
  });

  it("413s an oversized recording, naming the AUDIO limit and not the PDF one", async () => {
    // The regression this pins: two multipart routes with different caps share
    // one error handler, so a hardcoded label would be wrong on one of them.
    // middleware/error.ts resolves it from MulterError.field.
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x41);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(oversized);

    const res = await request(app)
      .post("/transcriptions")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", oversized, "recording.webm");

    assert.equal(res.status, 413);
    assert.match(res.body.error, /1 MB/);
  });

  it("still names the 4 MB limit on the PDF route", async () => {
    // The other half of the same regression. Both directions have to be pinned,
    // because a single-sided test passes just as happily with the labels swapped.
    const oversized = Buffer.alloc(5 * 1024 * 1024, 0x41);

    const res = await request(app)
      .post("/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", oversized, "big.pdf");

    assert.equal(res.status, 413);
    assert.match(res.body.error, /4 MB/);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const res = await request(app).get("/no-such-route");

    assert.equal(res.status, 404);
  });
});

describe("CORS", () => {
  it("allows the configured web origin to send an Authorization header", async () => {
    // The preflight that stands between the browser and every authenticated
    // request. If `authorization` is missing from allow-headers, the app works
    // perfectly under curl and fails entirely in a browser.
    const res = await request(app)
      .options("/documents")
      .set("Origin", process.env.WEB_ORIGIN ?? "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");

    assert.ok(res.status === 204 || res.status === 200, `preflight status ${res.status}`);
    assert.match(res.headers["access-control-allow-headers"] ?? "", /authorization/i);
  });
});

// A guard on the test environment itself, not on the app.
//
// Rate limiters are switched off under NODE_ENV=test (see the `skip` in
// middleware/rate-limit.ts). If that variable is ever lost, the limiters come
// back and tests start failing based on how many ran before them — a flake that
// looks like a real bug and is miserable to trace. Failing here instead names
// the cause immediately.
describe("test environment", () => {
  before(() => {
    assert.equal(
      process.env.NODE_ENV,
      "test",
      "NODE_ENV must be 'test' — run via `pnpm test`, which loads .env.test",
    );
  });

  it("has rate limiting disabled", async () => {
    // 25 unauthenticated requests, well past the 15/hour signup limit. All must
    // reach the auth guard (401) rather than the limiter (429).
    const results = await Promise.all(
      Array.from({ length: 25 }, () => request(app).get("/me")),
    );

    assert.ok(
      results.every((r) => r.status === 401),
      `expected every request to 401, saw ${[...new Set(results.map((r) => r.status))].join(", ")}`,
    );
  });
});
