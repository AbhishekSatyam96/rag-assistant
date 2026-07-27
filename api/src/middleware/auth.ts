import type { RequestHandler } from "express";
import { HttpError } from "../lib/http-error.js";
import { verifyToken } from "../lib/jwt.js";

// Guards protected routes. Clients send `Authorization: Bearer <token>`.
// On success we attach `req.user` and call next(); otherwise we 401.
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing or malformed Authorization header");
  }

  const token = header.slice("Bearer ".length);

  let claims;
  try {
    claims = await verifyToken(token);
  } catch {
    // Any verify failure (expired, tampered, garbage) → same 401.
    throw new HttpError(401, "Invalid or expired token");
  }

  req.user = { id: claims.sub, email: claims.email };
  next();
};
