// Validation length and count limits used across input schemas.
// Centralized here so a single source defines "what counts as a valid X."
// Server-only for now; promote to packages/shared if/when web enforces the
// same constraints client-side.

export const LIMITS = {
  // ─── String length tiers ───────────────────────────────────────────────
  TINY: 32, // priority strings, short tags
  TAG: 40, // task tag entries
  NAME: 64, // company / agent / user / target names
  TIMEZONE: 64, // IANA timezone strings ("Asia/Jakarta")
  CATEGORY: 120, // niche, content pillars
  LABEL: 128, // cron expression, hex IDs, generic labels (token name)
  TITLE: 200, // task title
  KEY: 256, // skill key, longer titles
  HOST: 253, // hostname / FQDN (RFC 1035 max length)
  REASON: 500, // rejection / cancel / pause reason
  API_KEY: 512, // adapter API keys
  URL: 2_048, // outbound target URLs (webhook endpoints)
  WEBHOOK_SECRET: 256, // HMAC signing secret for a company webhook
  FILE_PATH: 4_096, // absolute filesystem paths (Linux PATH_MAX)
  AUDIENCE: 1_000, // target audience text
  DESCRIPTION_SHORT: 2_000, // brand voice, audience descriptions, acceptance criteria
  DESCRIPTION: 4_000, // task description, comment body
  DESCRIPTION_LONG: 4_096, // routine description
  DELEGATE_BRIEF: 16_000, // editor→writer delegate brief; a thorough brief is the system working — never block a delegate over length
  CHAT_MESSAGE: 8_000, // agent chat message
  WORKSPACE_FILE_CONTENT: 100_000, // editable workspace file (AGENTS.md, SOUL.md, etc.)

  // ─── Tools primitive ───────────────────────────────────────────────────
  TOOL_LABEL: 80, // operator-facing nickname for a tool instance
  TOOL_TYPE: 64, // handler type slug ("x", "notion", "shopify", "mcp")
  TOOL_ACTION_NAME: 64, // action name within a handler ("tweet", "create_page")
  TOOL_CALL_INPUT: 16_384, // serialized invocation body upper bound
  TOOL_CALL_RESULT_SUMMARY: 4_096, // serialized result summary for tool_call_logs
  TOOL_ERROR_MESSAGE: 2_000, // captured error message stored on logs / row

  // ─── Spend bounds ──────────────────────────────────────────────────────
  MONTHLY_BUDGET_CENTS_MIN: 100, // $1 floor — a sub-dollar monthly pool is meaningless
  MONTHLY_BUDGET_CENTS_MAX: 1_000_000, // $10,000/mo ceiling — fat-finger guard, not a billing limit

  // ─── Array / count limits ──────────────────────────────────────────────
  TRIGGERS_MAX: 8, // routines: max trigger array
  TAGS_MAX: 20, // task: max tag count
  TASK_BLOCKS_MAX: 200, // task: max content block count
  DESIRED_SKILLS_MAX: 64, // agent: max desired skill keys
  PAGINATION_DEFAULT: 100,
  PAGINATION_MAX: 200,
  TASK_PAGE_SIZE: 50, // board column page size — one fetch per column, infinite scroll for more

  // ─── Auth crypto bounds ────────────────────────────────────────────────
  NONCE_MIN: 16,
  NONCE_MAX: 128,
  SIGNATURE_MIN: 40,
  SIGNATURE_MAX: 128,

  // ─── Agent action protocol ─────────────────────────────────────────────
  IDEMPOTENCY_KEY_MAX: 128, // agent-supplied dedupe key for /me/actions/emit
  // Foundation caps for HTTP-channel actions. Hardcoded floor;
  // per-company overrides come in feature phase. Depth=2 mirrors the
  // long-horizon degradation finding (pass rate drops 80%→38% past
  // depth 2 in chained-output benchmarks). Children=3 prevents fan-out
  // runaway and forces the LLM to prioritise.
  TASK_CHAIN_MAX_DEPTH: 2, // EmitFollowUp: deepest descendant a depth-0 task can spawn
  TASK_EMIT_MAX_CHILDREN: 3, // EmitFollowUp: max children one parent can spawn per agent
} as const;
