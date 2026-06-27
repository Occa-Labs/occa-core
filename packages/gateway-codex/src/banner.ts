// Startup splash for the CLI (bin.ts only — the library entry stays quiet so
// embedders and tests get no banner noise). Prints to stderr so stdout keeps
// pure JSON logs. Color is applied only on an interactive TTY and is dropped
// when NO_COLOR is set, so a systemd journal still gets a clean monochrome
// banner.

import type { GatewayConfig } from "./config";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
} as const;

function useColor(): boolean {
  return Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
}

function paint(code: string, s: string): string {
  return useColor() ? `${code}${s}${ANSI.reset}` : s;
}

// "OCCA" — ANSI Shadow figlet. Each row is the same visible width so the box
// below lines up under it.
const LOGO = [
  " ██████╗  ██████╗ ██████╗ █████╗ ",
  "██╔═══██╗██╔════╝██╔════╝██╔══██╗",
  "██║   ██║██║     ██║     ███████║",
  "██║   ██║██║     ██║     ██╔══██║",
  "╚██████╔╝╚██████╗╚██████╗██║  ██║",
  " ╚═════╝  ╚═════╝ ╚═════╝╚═╝  ╚═╝",
];

// Visible length ignores ANSI escapes, so a colored value inside a row still
// measures and pads to the right border correctly.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

const MIN_INNER = 49;
// Box auto-sizes to the longest row (+ a right gutter) so no value — a long
// host note, a verbose codex version — can overflow the right border.
function renderBox(rows: string[]): string[] {
  const inner = Math.max(MIN_INNER, ...rows.map(visibleLen)) + 2;
  const bar = paint(ANSI.cyan, "│");
  const top = paint(ANSI.cyan, `╭${"─".repeat(inner)}╮`);
  const bottom = paint(ANSI.cyan, `╰${"─".repeat(inner)}╯`);
  const body = rows.map(
    (c) => `${bar}${c}${" ".repeat(Math.max(0, inner - visibleLen(c)))}${bar}`,
  );
  return [top, ...body, bottom];
}

export interface BannerInput {
  config: GatewayConfig;
  version: string;
  codex: { ok: boolean; version?: string; reason?: string };
  /** Show an https:// listening URL (the gateway is serving TLS itself). */
  secure?: boolean;
}

export function printBanner({ config, version, codex, secure }: BannerInput): void {
  const scheme = (secure ?? Boolean(config.tls)) ? "https" : "http";
  const host = config.host ?? "0.0.0.0";
  const hostNote = config.host ? "" : "  (all interfaces)";
  const codexStatus = codex.ok
    ? paint(ANSI.green, `present  ${codex.version ?? ""}`.trim())
    : paint(ANSI.red, `not found — ${codex.reason ?? "install the codex CLI"}`);

  const lines: string[] = [
    "",
    ...LOGO.map((l) => `  ${paint(ANSI.cyan, l)}`),
    "",
    `  ${paint(ANSI.bold, "OCCA · Codex Gateway")}  ${paint(ANSI.dim, `v${version}`)}`,
    `  ${paint(ANSI.dim, "BYORT runtime that wraps `codex exec` over HTTP.")}`,
    "",
    ...renderBox([
      `  listening   ${scheme}://${host}:${config.port}${hostNote}`,
      `  bearer      configured`,
      `  codex       ${codexStatus}`,
      `  workspace   ${process.env.OCCA_CODEX_WORKSPACE_ROOT ?? "~/.occa-codex-agents"}`,
    ]),
    "",
    `  ${paint(ANSI.dim, "endpoints")}  /v1/health  /v1/seed  /v1/run  /v1/cancel  /v1/deprovision`,
    `  ${paint(ANSI.dim, "Ctrl+C to stop.")}`,
    "",
  ];

  process.stderr.write(`${lines.join("\n")}\n`);
}
