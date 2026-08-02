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
