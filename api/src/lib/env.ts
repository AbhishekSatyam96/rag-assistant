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
  // The rate limiters' shared store. Optional in development so a clone runs
  // with no infrastructure beyond Postgres, REQUIRED in production — see the
  // refinement below, which is the whole point of this variable existing.
  REDIS_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("redis://") || v.startsWith("rediss://"), {
      message: "REDIS_URL must start with redis:// or rediss://",
    })
    .optional(),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

// REDIS_URL is mandatory in production, and deliberately fatal rather than a
// silent fallback to the in-memory store.
//
// The memory store is EXACT on one instance and meaningless on many: the real
// limit becomes (limit x instance count), and this app is deployed to a platform
// that scales instances on its own. A fallback would therefore produce limits
// that report correctly in every header and enforce nothing — the same class of
// failure as a rate limiter with a bug, except silent and permanent.
//
// Refusing to boot is the right trade here specifically because signup is open
// and every question spends money at an external API. A process that will not
// start is a page of logs; a limiter that quietly stopped limiting is a bill.
const envSchema2 = envSchema.superRefine((val, ctx) => {
  if (val.NODE_ENV === "production" && !val.REDIS_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["REDIS_URL"],
      message:
        "REDIS_URL is required in production. Without it the rate limiters fall " +
        "back to per-instance memory, so the effective limit becomes (limit x " +
        "instances) and the global daily cap stops being global.",
    });
  }
});

const parsed = envSchema2.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// A single, fully-typed env object. Import this instead of touching process.env.
export const env = parsed.data;
