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
