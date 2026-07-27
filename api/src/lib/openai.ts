import OpenAI from "openai";
import { env } from "./env.js";

// A single shared OpenAI client for the whole app. Create it once here and
// import it wherever you need embeddings/completions — reusing one client keeps
// connection pooling and config in one place, rather than newing one up per call.
// The API key comes from the validated env, so a missing key fails at boot
// (see env.ts) instead of on the first request.
export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
