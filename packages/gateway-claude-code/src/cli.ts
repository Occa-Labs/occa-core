// The command-line surface. bin.ts is a thin shebang that hands argv here.
// Precedence is flag > env > stored config > default (see ./config). Zero
// dependencies — parsing uses node:util's parseArgs, so
// `npx @occa/gateway-claude-code` stays light.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  loadConfig,
  resolveConfig,
  readStoredConfig,
  writeStoredConfig,
  configFilePath,
  DEFAULT_PORT,
  type ConfigOverrides,
  type GatewayConfig,
  type StoredConfig,
} from "./config";
import { startGateway } from "./server";
import { claudeAvailable } from "./claude-cli";
import { printBanner } from "./banner";

const HELP = `occa-claude-gateway — Claude Gateway (BYORT runtime for OCCA)

A thin HTTP service that wraps the \`claude\` CLI so OCCA can run Claude Code
agents on a box it does not own. Install + authenticate \`claude\` first, set a
shared bearer, then start it.

USAGE
  occa-claude-gateway [command] [options]

COMMANDS
  start                     Start the gateway (default when no command is given)
  doctor                    Check the claude CLI + auth and print the resolved config
  config set <key> <value>  Persist a setting (token, port, host, health-model,
                            workspace, tls-cert, tls-key)
  config get [key]          Print stored settings
  config unset <key>        Remove a stored setting
  config path               Print the config file path

OPTIONS
  -t, --token <bearer>      Shared bearer clients must send   [env CLAUDE_GATEWAY_TOKEN]
  -p, --port <number>       Listen port (default ${DEFAULT_PORT})         [env CLAUDE_GATEWAY_PORT]
  -H, --host <address>      Bind address (default all)         [env CLAUDE_GATEWAY_HOST]
      --tls-cert <path>     PEM cert — serve HTTPS (needs --tls-key)
      --tls-key <path>      PEM private key — serve HTTPS (needs --tls-cert)
      --health-model <name> Health-probe model (default sonnet)
      --workspace <dir>     Per-agent workspace root           [env OCCA_CLAUDE_WORKSPACE_ROOT]
      --no-banner           Don't print the startup splash
      --banner              Print the splash and exit
  -h, --help                Show this help
  -v, --version             Show version

EXAMPLES
  occa-claude-gateway config set token s3cret   # save it once…
  occa-claude-gateway                           # …then just run
  occa-claude-gateway doctor`;

// Keys accepted by `config set/unset`, mapped to the stored field name.
const CONFIG_KEYS: Record<string, keyof StoredConfig> = {
  token: "token",
  port: "port",
  host: "host",
  "health-model": "healthModel",
  workspace: "workspace",
  "tls-cert": "tlsCert",
  "tls-key": "tlsKey",
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\nRun \`occa-claude-gateway --help\` for usage.\n`);
  process.exit(1);
}

export async function runCli(argv: string[]): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        token: { type: "string", short: "t" },
        port: { type: "string", short: "p" },
        host: { type: "string", short: "H" },
        "health-model": { type: "string" },
        workspace: { type: "string" },
        "tls-cert": { type: "string" },
        "tls-key": { type: "string" },
        "no-banner": { type: "boolean" },
        banner: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    fail((err as Error).message);
  }

  const version = readVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const command = positionals[0] ?? "start";

  // `config` manages the stored file and never starts the server.
  if (command === "config") {
    runConfig(positionals.slice(1));
    return;
  }

  // Resolve the workspace root (flag > env > stored) into the env var that
  // workspacePathFor reads, so a stored/flagged value takes effect.
  const stored = readStoredConfig();
  const workspace =
    (typeof values.workspace === "string" && values.workspace) ||
    process.env.OCCA_CLAUDE_WORKSPACE_ROOT ||
    stored.workspace;
  if (workspace) process.env.OCCA_CLAUDE_WORKSPACE_ROOT = workspace;

  const overrides: ConfigOverrides = {};
  if (typeof values.token === "string") overrides.token = values.token;
  if (typeof values.host === "string") overrides.host = values.host;
  if (typeof values["health-model"] === "string") overrides.healthModel = values["health-model"];
  if (typeof values["tls-cert"] === "string") overrides.tlsCert = values["tls-cert"];
  if (typeof values["tls-key"] === "string") overrides.tlsKey = values["tls-key"];
  if (typeof values.port === "string") {
    const p = Number(values.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) fail(`invalid --port: ${values.port}`);
    overrides.port = p;
  }

  // --banner: preview the splash and exit (no server, no bearer needed).
  if (values.banner) {
    const r = resolveConfig(overrides);
    printBanner({ config: r, version, claude: await claudeAvailable(), secure: r.scheme === "https" });
    return;
  }

  if (command === "doctor") {
    await runDoctor(overrides, version);
    return;
  }
  if (command === "start") {
    await runStart(overrides, version, values["no-banner"] !== true);
    return;
  }
  fail(`unknown command "${command}"`);
}

function runConfig(args: string[]): void {
  const sub = args[0];
  if (sub === "path") {
    process.stdout.write(`${configFilePath()}\n`);
    return;
  }
  if (sub === "get") {
    const stored = readStoredConfig();
    const key = args[1];
    if (key) {
      const field = CONFIG_KEYS[key];
      if (!field) fail(`unknown key "${key}" — one of: ${Object.keys(CONFIG_KEYS).join(", ")}`);
      const v = stored[field];
      process.stdout.write(`${v === undefined ? "(not set)" : v}\n`);
      return;
    }
    const entries = Object.entries(CONFIG_KEYS)
      .map(([cli, field]) => [cli, stored[field]] as const)
      .filter(([, v]) => v !== undefined);
    process.stdout.write(
      entries.length === 0
        ? `(empty) — ${configFilePath()}\n`
        : `${entries.map(([k, v]) => `  ${k.padEnd(13)}${v}`).join("\n")}\n`,
    );
    return;
  }
  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    const field = key ? CONFIG_KEYS[key] : undefined;
    if (!field) fail(`usage: config set <${Object.keys(CONFIG_KEYS).join("|")}> <value>`);
    if (value === undefined) fail(`config set ${key} needs a value`);
    const stored = readStoredConfig();
    if (field === "port") {
      const p = Number(value);
      if (!Number.isInteger(p) || p < 0 || p > 65535) fail(`invalid port: ${value}`);
      stored.port = p;
    } else {
      stored[field] = value;
    }
    writeStoredConfig(stored);
    process.stdout.write(`saved ${key} → ${configFilePath()}\n`);
    return;
  }
  if (sub === "unset") {
    const key = args[1];
    const field = key ? CONFIG_KEYS[key] : undefined;
    if (!field) fail(`usage: config unset <${Object.keys(CONFIG_KEYS).join("|")}>`);
    const stored = readStoredConfig();
    delete stored[field];
    writeStoredConfig(stored);
    process.stdout.write(`unset ${key}\n`);
    return;
  }
  fail("usage: config <set|get|unset|path> …");
}

async function runStart(
  overrides: ConfigOverrides,
  version: string,
  showBanner: boolean,
): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfig(overrides);
  } catch (err) {
    fail((err as Error).message);
  }
  const claude = await claudeAvailable();
  if (showBanner) printBanner({ config, version, claude });
  startGateway(config);
}

async function runDoctor(overrides: ConfigOverrides, version: string): Promise<void> {
  const c = resolveConfig(overrides);
  const claude = await claudeAvailable();
  const tlsHalf = Boolean(c.tlsCertPath) !== Boolean(c.tlsKeyPath);
  const ok = claude.ok && c.tokenSet && !tlsHalf;
  const line = (label: string, value: string) => `  ${label.padEnd(12)}${value}`;
  const out = [
    `occa-claude-gateway doctor — v${version}`,
    "",
    line("claude", claude.ok ? `ok (${claude.version ?? "present"})` : `FAILED — ${claude.reason ?? "not found"}`),
    line("token", c.tokenSet ? "set" : "MISSING — `config set token <bearer>` or --token"),
    line("scheme", tlsHalf ? `${c.scheme} — INCOMPLETE, need both tls-cert and tls-key` : c.scheme),
    line("host", c.host ?? "0.0.0.0 (all interfaces)"),
    line("port", String(c.port)),
    line("tls-cert", c.tlsCertPath ?? "—"),
    line("tls-key", c.tlsKeyPath ?? "—"),
    line("health", c.healthModel),
    line("workspace", process.env.OCCA_CLAUDE_WORKSPACE_ROOT ?? "~/.occa-claude-agents"),
    line("config", configFilePath()),
    "",
    ok ? "ready to start." : "not ready — fix the items above.",
  ];
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(ok ? 0 : 1);
}
