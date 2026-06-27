// Gateway config. Resolved from three sources, highest precedence first:
//   1. CLI flags (ConfigOverrides)         — `--token`, `--port`, …
//   2. environment                          — CODEX_GATEWAY_*
//   3. the stored config file               — `config set …`
// then defaults. The bearer is the only shared secret; it goes into the OCCA
// deployment's adapterConfig.apiKey. Codex's own model auth (OPENAI_API_KEY /
// `codex login`) lives on the box and is never handled here.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  /** Shared bearer. OCCA sends it as `Authorization: Bearer <token>`. */
  token: string;
  /** Bind address. Undefined = dual-stack all-interfaces, so localhost,
   *  127.0.0.1, and a remote OCCA all reach it. Set CODEX_GATEWAY_HOST=
   *  127.0.0.1 to restrict to loopback. */
  host: string | undefined;
  port: number;
  /** Max JSON request body size. Wake/seed payloads are a few KB. */
  maxBodyBytes: number;
  /** When set, the gateway serves HTTPS itself with this PEM key + cert.
   *  Absent = plain HTTP — front it with a TLS-terminating reverse proxy. */
  tls?: { key: string; cert: string };
}

// Distinct default port from the Claude Gateway (8718) so both can run on the
// same box without colliding.
export const DEFAULT_PORT = 8719;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — seeded files can be large.

/** CLI-supplied values that take precedence over the environment + file. */
export interface ConfigOverrides {
  token?: string;
  port?: number;
  host?: string;
  tlsCert?: string;
  tlsKey?: string;
}

export interface StoredConfig {
  token?: string;
  port?: number;
  host?: string;
  /** Per-agent workspace root (applied via OCCA_CODEX_WORKSPACE_ROOT). */
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
  return join(base, "occa-codex-gateway");
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

function numEnv(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve config without throwing. `tokenSet` reports whether a bearer was
 *  found anywhere; describes the transport too. Used by `doctor`/`--banner`. */
export function resolveConfig(overrides: ConfigOverrides = {}): GatewayConfig & {
  tokenSet: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  scheme: "http" | "https";
} {
  const file = readStoredConfig();
  const token = overrides.token ?? process.env.CODEX_GATEWAY_TOKEN ?? file.token ?? "";
  const host = overrides.host ?? process.env.CODEX_GATEWAY_HOST ?? file.host;
  const tlsCertPath = overrides.tlsCert ?? process.env.CODEX_GATEWAY_TLS_CERT ?? file.tlsCert;
  const tlsKeyPath = overrides.tlsKey ?? process.env.CODEX_GATEWAY_TLS_KEY ?? file.tlsKey;
  return {
    token,
    tokenSet: token.length > 0,
    host: host && host.length > 0 ? host : undefined,
    port: overrides.port ?? numEnv(process.env.CODEX_GATEWAY_PORT) ?? file.port ?? DEFAULT_PORT,
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
      "a bearer token is required — set one with `occa-codex-gateway config set token <bearer>`, pass --token, or set CODEX_GATEWAY_TOKEN",
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
