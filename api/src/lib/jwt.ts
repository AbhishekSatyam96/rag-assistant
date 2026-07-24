import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

// jose wants the secret as bytes, not a string. Encode it once at module load.
const secret = new TextEncoder().encode(env.JWT_SECRET);
const alg = "HS256"; // HMAC-SHA256: symmetric, one shared secret signs & verifies.

export interface TokenClaims {
  sub: string; // subject — the user id (a JWT-standard claim)
  email: string;
}

// Produce a signed token. It is NOT encrypted — anyone can base64-decode and read
// the claims — but they can't forge or tamper with it without JWT_SECRET.
// So: never put secrets in the payload; do put a short expiry on it.
export async function signToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

// Throws if the token is missing, malformed, tampered with, or expired.
export async function verifyToken(token: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, secret);
  return { sub: payload.sub as string, email: payload.email as string };
}
