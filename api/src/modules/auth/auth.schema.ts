import { z } from "zod";

// One schema, used two ways:
//   1) at runtime to validate/parse the request body (reject junk at the door)
//   2) at compile time as the `Credentials` type (single source of truth)
export const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type Credentials = z.infer<typeof credentialsSchema>;
