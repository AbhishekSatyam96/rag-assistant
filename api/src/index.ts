import { createApp } from "./create-app";
import { env } from "./lib/env";

// THE ENTRYPOINT, and the only file that should be one.
//
// Vercel discovers the app by filename, checking `app.*`, `index.*`, `server.*`
// and then the same three under `src/` — first match wins. `src/app.ts` used to
// exist and would have been found FIRST, and it exported `createApp` (a factory)
// rather than an app instance, satisfying neither of the two contracts Vercel
// accepts. Hence the rename to create-app.ts: the ambiguity is removed rather
// than worked around, and the createApp/listen separation built back in M1
// survives intact.
const app = createApp();

// Vercel imports this module and drives the exported app itself — there is no
// port to bind and no process that outlives a request. Locally there is both,
// so the listener stays, guarded. `pnpm dev` binds a port; Vercel never does.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    console.log(`API on http://localhost:${env.PORT}`);
  });
}

export default app;
