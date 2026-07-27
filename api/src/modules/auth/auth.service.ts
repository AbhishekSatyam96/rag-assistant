import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/http-error.js";
import { signToken } from "../../lib/jwt.js";
import { env } from "../../lib/env.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { Credentials, SignupInput } from "./auth.schema.js";

// The service layer holds business logic and talks to the DB. It knows nothing
// about `req`/`res` — that's the route's job. Keeping it HTTP-free means we can
// unit-test it directly and reuse it later (e.g. a CLI seed script).

function toPublicUser(user: { id: string; email: string }) {
  // Never return the password hash to the client.
  return { id: user.id, email: user.email };
}

export async function signup({ email, password, inviteCode }: SignupInput) {
  // The signup gate, and the reason it is OFF by default: every per-user budget
  // in middleware/rate-limit.ts is only as strong as the cost of getting
  // another user. Right now that cost is zero, which is a deliberate trade — a
  // recruiter opening the demo must not hit a wall — so the budgets are sized
  // to make an army of free accounts unprofitable rather than impossible.
  //
  // Setting SIGNUP_INVITE_CODE flips that trade in one config change, no
  // deploy of new code: the door closes to everyone without the code. That is
  // the lever to pull when the OpenAI spend alert fires, not a rewrite at 2am.
  //
  // The comparison is a plain !== rather than a timing-safe compare. That is a
  // considered choice: this is a coarse gate, not a password, and guessing it
  // is bounded to 5 attempts an hour per subnet by signupLimiter — which is a
  // far tighter bound than anything a timing side-channel could give an
  // attacker here. A shared secret worth more than this would deserve
  // crypto.timingSafeEqual and a per-invite record in the database.
  if (env.SIGNUP_INVITE_CODE && inviteCode !== env.SIGNUP_INVITE_CODE) {
    throw new HttpError(403, "Sign-ups are invite-only right now.");
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new HttpError(409, "Email already registered");
  }

  const user = await prisma.user.create({
    data: { email, password: await hashPassword(password) },
  });

  const token = await signToken({ sub: user.id, email: user.email });
  return { user: toPublicUser(user), token };
}

export async function login({ email, password }: Credentials) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Same error whether the email is unknown or the password is wrong, so we
  // don't reveal which emails are registered (user-enumeration defense).
  if (!user || !(await verifyPassword(user.password, password))) {
    throw new HttpError(401, "Invalid email or password");
  }

  const token = await signToken({ sub: user.id, email: user.email });
  return { user: toPublicUser(user), token };
}
