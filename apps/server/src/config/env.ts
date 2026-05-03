// Validated environment variables. Server fail-fast on boot if any required
// var is missing or malformed — better than discovering at runtime that the
// gateway hostname is undefined.
//
// Add new env vars here, not by sprinkling `process.env.X` across the code.

import { z } from "zod";

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .optional(),

  // Web client origin for CORS
  CORS_ORIGIN: z.string().url().default("http://localhost:3001"),

  // Database
  DATABASE_URL: z.string().min(1).default("postgresql://localhost:5432/occa"),

  // Auth (legacy nonce flow + new Privy flow both issue this JWT)
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),

  // Privy — user authentication via embedded wallet / social login.
  // Get from https://console.privy.io. App ID is public-safe; secret is server-only.
  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),

  // OCCA's own API base URL — written into agent workspace files so an
  // agent knows where to call back. Defaults to localhost in dev.
  OCCA_API_URL: z.string().url().optional(),

  // GitHub PAT for fetching built-in skills from public repos. Optional —
  // anonymous access is rate-limited but functional in dev.
  GITHUB_TOKEN: z.string().min(1).optional(),

  // Gateway SSH access (only used by the dev/ops route — not core path).
  OCCA_GATEWAY_SSH_HOST: z.string().optional(),
  OCCA_GATEWAY_SSH_USER: z.string().optional(),
  OCCA_GATEWAY_SSH_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
