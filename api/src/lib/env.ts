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
