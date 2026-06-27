# gateway-codex — Phase 2 build reference

Facts for wrapping the `codex` CLI in an HTTP gateway, mirroring
`@occa/gateway-claude-code`. **VERIFIED against codex-cli 0.142.3 on macOS
(2026-06-27)** — `codex exec --help`, `codex exec resume --help`, and a live
`codex exec --json` run. Earlier deep-research notes (developers.openai.com,
openai/codex) are folded in where they still hold. **This tool moves fast — pin
a version and re-run the help + a JSONL capture before prod.**

## One headless turn (the core command) — VERIFIED 0.142.3

```
codex exec --json \
  -m gpt-5.5 \
  -C <workspace> \
  --skip-git-repo-check \
  -s workspace-write \
  "<prompt>"
```

- Prompt: positional arg, or `-` to read from stdin. (Both = arg is the
  instruction, piped stdin is appended as a `<stdin>` block.)
- `-m` / `--model`: model slug (see below).
- `-C` / `--cd`: workspace root. Each OCCA agent gets its own dir.
- `--skip-git-repo-check`: required — codex refuses non-git dirs by default.
- `-s` / `--sandbox`: `read-only` (default) | `workspace-write` | `danger-full-access`.
  Use `workspace-write` for task mode, `read-only` for chat.
- `--json`: stdout becomes a JSONL event stream. (NOTE: in 0.142.3 there is no
  `--experimental-json` alias shown — just `--json`.)
- **CORRECTION vs research: `codex exec` has NO `-a` / `--ask-for-approval`
  flag.** exec is non-interactive and does NOT prompt — there is nothing to
  disable. (The `-a` flag the research cited is on the interactive `codex`
  command, not `exec`.) If you ever need to force a policy, use a config
  override: `-c approval_policy="never"`. No `--full-auto` in exec either.
- Fully unrestricted (no sandbox): `--dangerously-bypass-approvals-and-sandbox`.
  Only inside an externally hardened box. (No `--yolo` alias on exec in 0.142.3.)
- **stderr noise:** the run emits `ERROR codex_models_manager ... failed to
  refresh available models` to STDERR — non-fatal (exit 0, answer still
  produced). The gateway must read **stdout only** for JSONL; treat stderr as
  logs, never parse it.
- Bonus flags worth knowing: `--ephemeral` (don't persist the session to disk —
  good for chat), `-o <file>` (write final message to a file), `--add-dir`
  (extra writable dirs), `--output-schema <file>` (force final-response JSON
  shape), `-c key=value` (override any config.toml key inline).

## JSONL event schema (`codex exec --json`) — VERIFIED 0.142.3

One JSON object per line, top-level `type` field. Ignore unknown fields. A real
read-only "say hi" run produced exactly:

```
{"type":"thread.started","thread_id":"019f0746-e657-7e31-b90c-fa09a7950e2a"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello there"}}
{"type":"turn.completed","usage":{"input_tokens":11029,"cached_input_tokens":9088,"output_tokens":6,"reasoning_output_tokens":0}}
```

Items emit `item.started` then `item.completed` (same `id`). Verified `item.type` values:

| `item.type` | Shape | Maps to CodexStreamEvent |
| --- | --- | --- |
| `agent_message` | `{id, type, text}` (completed only) | assistant text; LAST one = final reply |
| `command_execution` | `{id, type, command, aggregated_output, exit_code, status}` — status `in_progress`→`completed`, exit_code `null`→int, output accumulates | started → `tool_use` (toolName `"command"`, toolInput=`command`); completed → `tool_result` (toolResult=`aggregated_output`, isError=`exit_code !== 0`) |
| `file_change` | `{id, type, changes:[{path, kind}], status}` — kind `add`/`modify`/`delete` | started → `tool_use` (toolName `"file_change"`, toolInput=`changes`); completed → `tool_result` |

Top-level events:

| Event | Shape / use |
| --- | --- |
| `thread.started` | `{thread_id:"<uuid>"}` — **capture → sessionId, used for resume** |
| `turn.started` | `{}` |
| `turn.completed` | `{usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}` — **token usage; run ends here** |

There is NO separate `{t:"result"}` line (unlike the claude gateway wire). The
final reply = the last `agent_message` item's `text`; the run ends at
`turn.completed`. Note even a tiny prompt costs ~11k+ input tokens (codex
injects a large system prompt + AGENTS.md + tool defs; most cached).

`RunCodexResult` assembly: reply = last `agent_message.text`; usage from
`turn.completed.usage` (`input_tokens`→inputTokens, `cached_input_tokens`→
cachedTokensIn, `output_tokens`→outputTokens); sessionId = `thread.started.thread_id`.

## Session continuity — THE key difference from Claude Code

Claude Code resumes by a session uuid OCCA derives deterministically from the
sessionKey. **Codex cannot do this** — there is currently NO flag to supply a
session id (`--session-id` does not exist; feature requests #15767 / #17782 are
open/undocumented). So the gateway must:

1. **First turn for a sessionKey:** run a fresh `codex exec`, read the
   `thread_id` out of the `thread.started` event, and persist a mapping
   `sessionKey → thread_id` on the gateway box (e.g. a small JSON file in the
   agent workspace).
2. **Subsequent turns:** `codex exec resume <SESSION_ID> --json "<prompt>"`.
   VERIFIED on 0.142.3: `resume` is a subcommand of `exec`, signature
   `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, and `--json` / `-m` /
   `--skip-git-repo-check` / `--ephemeral` are flags ON the `resume` subcommand.
   SESSION_ID is the thread UUID (or a thread name). `--last` resumes the most
   recent recorded session; `--all` disables cwd filtering.
3. **resetSession (thread clear):** OCCA bumps `resetGeneration` in the
   sessionKey → no stored mapping → gateway starts a fresh thread. Nothing to
   wipe.

Rollout files live at `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` —
filenames/ids are auto-generated, not settable. `--ephemeral` skips persisting
the session entirely (use for chat turns that don't need continuity).

## Headless auth

- Per-run: `CODEX_API_KEY=<key> codex exec --json ...` (inline; `exec`-only).
- Or `OPENAI_API_KEY` in the process env.
- Or `~/.codex/auth.json` (ChatGPT login token OR a raw key). Treat as a secret.

OCCA stores only the gateway bearer per agent. The model credential lives on the
gateway box — same trust model as the Claude Gateway.

## Config (`~/.codex/config.toml`)

User-level `~/.codex/config.toml`, optional project `.codex/config.toml`
(can't override provider/auth/profile/telemetry keys). Relevant keys:
`model`, `sandbox_mode` (read-only | workspace-write | danger-full-access),
`approval_policy` (untrusted | on-request | never), `web_search`.

## Context file

`AGENTS.md` is the auto-loaded project context file (plus global
`~/.codex/AGENTS.md`). OCCA's adapter already seeds persona + skills into
`AGENTS.md` — correct.

## Cost / budget

**No per-run token or USD cap flag exists.** Token usage is only REPORTED
(`turn.completed.usage`), never capped at the CLI. The gateway/adapter bounds
cost by the wall-clock `timeoutMs` + OCCA's monthly treasury gate at dispatch.
If a hard cap is ever needed, the wrapper must parse `usage` mid-stream and kill
the process. (The wire's `maxBudgetUsd` is intentionally ignored by this gateway.)

## Web search

`--search` flag == config `web_search = "live"`. Values: `cached` (default),
`live`, `disabled`. Auto-flips to `live` under `--yolo` / full-access.

## Model slugs (current as of Apr 2026 — churns ~monthly)

| Slug | Note |
| --- | --- |
| `gpt-5.5` | Newest frontier, complex coding — **OCCA default** |
| `gpt-5.4` | Flagship |
| `gpt-5.4-mini` | Fast/efficient mini, subagents |
| `gpt-5.3-codex-spark` | Text-only research preview, ChatGPT Pro only |

**Do NOT use** `gpt-5.5-codex` (doesn't exist), `o4-mini` (retired 2026-02-13),
`gpt-5-codex` (historical, not current). Several older codex slugs (gpt-5.2/5.3-codex)
sunset ~2026-07-23. Always keep a fallback.

## Two programmatic interfaces (pick ONE)

1. `codex exec --json` — flat `type:` events. Simpler; fire-and-resume. **Use this**
   (mirrors the gateway-claude-code shape).
2. `codex-rs/app-server` JSON-RPC (`thread/start`→id, `thread/resume`,
   `turn/start`, `thread/tokenUsage/updated`). Finer lifecycle control, different
   event schema. Don't mix the two shapes.

## Primary sources

- developers.openai.com/codex/cli/reference (flags)
- developers.openai.com/codex/noninteractive (exec, --json, resume, auth)
- developers.openai.com/codex/models (slugs)
- developers.openai.com/codex/agent-approvals-security (sandbox/approval)
- developers.openai.com/codex/config-reference (config.toml)
- github.com/openai/codex (cli.rs, app-server README, issues #13614 #14345 #15767)
