import "dotenv/config";
import { z } from "zod";

// Validate environment at startup so the app fails fast with a clear message,
// instead of blowing up deep inside a request when a var is missing/wrong.
// (Frontend analogy: like validating a form on submit — but here the "form" is
// the process environment, checked once at boot.)
const envSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  // The generation model, overridable without a code change so a model swap is
  // a deploy-config decision. Note that the EMBEDDING model is deliberately NOT
  // configurable (it's a constant in lib/embed.ts): changing it invalidates
  // every vector already in the database, so it must never be an env-var flip.
  CHAT_MODEL: z.string().min(1).default("gpt-4o-mini"),
  // The signup gate. UNSET means signup is open to anyone, which is the
  // deliberate default for a demo people are meant to be able to try. Set it
  // and POST /auth/signup requires a matching `inviteCode` — the one-config-
  // change lever for when open signup starts costing real money.
  //
  // `.optional()` with a `.min(1)` inside it, not a default of "": an empty
  // string is exactly the value that would look configured while silently
  // disabling the check, so it is rejected at startup instead.
  SIGNUP_INVITE_CODE: z.string().min(1).optional(),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// A single, fully-typed env object. Import this instead of touching process.env.
export const env = parsed.data;
