// Gateway config. Resolved from three sources, highest precedence first:
//   1. CLI flags (ConfigOverrides)         — `--token`, `--port`, …
//   2. environment                          — CLAUDE_GATEWAY_*
//   3. the stored config file               — `config set …` (see below)
// then defaults. The bearer is the only shared secret; it goes into the OCCA
// deployment's adapterConfig.apiKey.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** When set, the gateway serves HTTPS itself with this PEM key + cert
   *  (loaded from the tls-cert/tls-key paths). Absent = plain HTTP, the
   *  default — front it with a TLS-terminating reverse proxy in that case. */
  tls?: { key: string; cert: string };
}

export const DEFAULT_PORT = 8718;
const DEFAULT_HEALTH_MODEL = "sonnet";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — seeded files can be large.

/** CLI-supplied values that take precedence over the environment + file. */
export interface ConfigOverrides {
  token?: string;
  port?: number;
  host?: string;
  healthModel?: string;
  tlsCert?: string;
  tlsKey?: string;
}

// ── Stored config (`config set …`) ──────────────────────────────────────────
// Persisted so the box owner sets the bearer/port once instead of passing
// flags every run. Plaintext (like an env var or a systemd unit), written
// 0600. Keys mirror the flags.

export interface StoredConfig {
  token?: string;
  port?: number;
  host?: string;
  healthModel?: string;
  /** Per-agent workspace root (applied via OCCA_CLAUDE_WORKSPACE_ROOT). */
  workspace?: string;
  /** PEM cert + key paths. Both set → serve HTTPS. */
  tlsCert?: string;
  tlsKey?: string;
}

export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "occa-claude-gateway");
}

export function configFilePath(): string {
  return join(configDir(), "config.json");
}

export function readStoredConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(configFilePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StoredConfig)
      : {};
  } catch {
    return {}; // missing or unreadable → empty, callers fall back to env/defaults
  }
}

export function writeStoredConfig(next: StoredConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(configFilePath(), 0o600); // tighten even if the file pre-existed
  } catch {
    /* best effort */
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

function numEnv(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve config without throwing. `tokenSet` reports whether a bearer was
 *  found anywhere; `tlsCertPath`/`tlsKeyPath`/`scheme` describe the transport.
 *  Used by `doctor`/`--banner`, which describe rather than start (no file
 *  reads). */
export function resolveConfig(overrides: ConfigOverrides = {}): GatewayConfig & {
  tokenSet: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  scheme: "http" | "https";
} {
  const file = readStoredConfig();
  const token = overrides.token ?? process.env.CLAUDE_GATEWAY_TOKEN ?? file.token ?? "";
  const host = overrides.host ?? process.env.CLAUDE_GATEWAY_HOST ?? file.host;
  const tlsCertPath = overrides.tlsCert ?? process.env.CLAUDE_GATEWAY_TLS_CERT ?? file.tlsCert;
  const tlsKeyPath = overrides.tlsKey ?? process.env.CLAUDE_GATEWAY_TLS_KEY ?? file.tlsKey;
  return {
    token,
    tokenSet: token.length > 0,
    host: host && host.length > 0 ? host : undefined,
    port: overrides.port ?? numEnv(process.env.CLAUDE_GATEWAY_PORT) ?? file.port ?? DEFAULT_PORT,
    healthModel:
      overrides.healthModel ??
      process.env.CLAUDE_GATEWAY_HEALTH_MODEL ??
      file.healthModel ??
      DEFAULT_HEALTH_MODEL,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    tlsCertPath,
    tlsKeyPath,
    scheme: tlsCertPath && tlsKeyPath ? "https" : "http",
  };
}

// Resolve config to start the server. Throws when no bearer is resolvable, or
// when TLS is half-configured / the PEM files can't be read.
export function loadConfig(overrides: ConfigOverrides = {}): GatewayConfig {
  const { tokenSet, tlsCertPath, tlsKeyPath, scheme: _scheme, ...config } = resolveConfig(overrides);
  if (!tokenSet) {
    throw new Error(
      "a bearer token is required — set one with `occa-claude-gateway config set token <bearer>`, pass --token, or set CLAUDE_GATEWAY_TOKEN",
    );
  }
  if (tlsCertPath || tlsKeyPath) {
    if (!tlsCertPath || !tlsKeyPath) {
      throw new Error("https needs both tls-cert and tls-key — set the missing one");
    }
    try {
      config.tls = {
        cert: readFileSync(tlsCertPath, "utf8"),
        key: readFileSync(tlsKeyPath, "utf8"),
      };
    } catch (err) {
      throw new Error(`could not read TLS cert/key: ${(err as Error).message}`);
    }
  }
  return config;
}
