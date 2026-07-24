import { hash, verify } from "@node-rs/argon2";

// Why not just store the password, or SHA-256 it?
//   - Plaintext: a DB leak = every account compromised.
//   - Fast hashes (SHA-256/MD5): a GPU tries billions/sec → brute-forced.
// Argon2id is deliberately SLOW and memory-hard, so cracking is expensive.
// The library also generates a random per-password salt and embeds it (plus the
// algorithm params) inside the returned string, so we don't manage salts by hand.
// Its defaults follow current OWASP guidance — good enough to not hand-tune.

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

// Note: we pass the stored digest first, then the candidate password.
// verify() re-derives the hash using the salt/params baked into `digest`.
export function verifyPassword(digest: string, plain: string): Promise<boolean> {
  return verify(digest, plain);
}
