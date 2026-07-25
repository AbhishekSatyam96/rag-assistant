import { z } from "zod";

// One schema, used two ways:
//   1) at runtime to validate/parse the request body (reject junk at the door)
//   2) at compile time as the `Credentials` type (single source of truth)
export const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type Credentials = z.infer<typeof credentialsSchema>;

// Signup takes one extra, optional field. It has to be declared here even
// though it is optional: zod STRIPS unknown keys, so without this line a client
// sending `inviteCode` would have it silently removed before the service ever
// saw it, and the gate below would reject everyone.
//
// Optional in the schema, conditionally REQUIRED in the service — because
// whether an invite is needed depends on SIGNUP_INVITE_CODE being set in the
// environment, and a schema that reads process.env is a schema you cannot test
// without mutating the environment first.
export const signupSchema = credentialsSchema.extend({
  inviteCode: z.string().trim().optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
