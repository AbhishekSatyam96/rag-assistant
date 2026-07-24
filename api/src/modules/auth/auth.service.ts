import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/http-error";
import { signToken } from "../../lib/jwt";
import { hashPassword, verifyPassword } from "./password";
import type { Credentials } from "./auth.schema";

// The service layer holds business logic and talks to the DB. It knows nothing
// about `req`/`res` — that's the route's job. Keeping it HTTP-free means we can
// unit-test it directly and reuse it later (e.g. a CLI seed script).

function toPublicUser(user: { id: string; email: string }) {
  // Never return the password hash to the client.
  return { id: user.id, email: user.email };
}

export async function signup({ email, password }: Credentials) {
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
