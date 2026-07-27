import app from "./app.js";
import { env } from "./lib/env.js";

// LOCAL DEVELOPMENT ONLY. `pnpm dev` runs this file; Vercel never loads it.
//
// Vercel resolves src/app.ts as the entrypoint (it comes before src/index.ts in
// the detection order) and drives the app it default-exports directly — there
// is no port to bind and no process that outlives a request. Locally there is
// both, so the listener lives here, which keeps "build the app" and "start
// listening" in separate files exactly as they have been since M1.
//
// Importing the default export rather than calling createApp() again matters:
// a second call would construct a second app with its own rate-limiter and
// concurrency counters, and only one of them would ever see a request.
app.listen(env.PORT, () => {
  console.log(`API on http://localhost:${env.PORT}`);
});
