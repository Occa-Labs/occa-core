// Gateway config, read once from the environment at boot. The box owner
// (BYORT host) sets these; OCCA never sees them. The bearer is the only
// shared secret — it goes into the OCCA deployment's adapterConfig.apiKey.

export interface GatewayConfig {
  /** Shared bearer. OCCA sends it as `Authorization: Bearer <token>`. */
  token: string;
  /** Bind address. Undefined = dual-stack all-interfaces (Node binds `::`
   *  with IPv4 mapped), so both `localhost` (IPv6 ::1) and `127.0.0.1`
   *  reach it — and a remote OCCA can too, which is the BYORT point. Set
   *  CLAUDE_GATEWAY_HOST=127.0.0.1 to restrict to loopback. */
  host: string | undefined;
  port: number;
  /** Model used by the health probe (a cheap real `claude -p` call). */
  healthModel: string;
  /** Max JSON request body size. Wake/seed payloads are a few KB. */
  maxBodyBytes: number;
}

const DEFAULT_PORT = 8718;
const DEFAULT_HEALTH_MODEL = "sonnet";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — seeded files can be large.

export function loadConfig(): GatewayConfig {
  const token = process.env.CLAUDE_GATEWAY_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "CLAUDE_GATEWAY_TOKEN is required — set a bearer the OCCA deployment will use",
    );
  }
  const port = Number(process.env.CLAUDE_GATEWAY_PORT ?? DEFAULT_PORT);
  const host = process.env.CLAUDE_GATEWAY_HOST;
  return {
    token,
    host: host && host.length > 0 ? host : undefined,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    healthModel: process.env.CLAUDE_GATEWAY_HEALTH_MODEL ?? DEFAULT_HEALTH_MODEL,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
}
