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
  REASON: 500, // rejection / cancel / pause reason
  API_KEY: 512, // adapter API keys
  AUDIENCE: 1_000, // target audience text
  DESCRIPTION_SHORT: 2_000, // brand voice, audience descriptions, acceptance criteria
  DESCRIPTION: 4_000, // task description, comment body
  DESCRIPTION_LONG: 4_096, // routine description
  CHAT_MESSAGE: 8_000, // agent chat message

  // ─── Array / count limits ──────────────────────────────────────────────
  TRIGGERS_MAX: 8, // routines: max trigger array
  TAGS_MAX: 20, // task: max tag count
  TASK_BLOCKS_MAX: 200, // task: max content block count
  DESIRED_SKILLS_MAX: 64, // agent: max desired skill keys
  PAGINATION_DEFAULT: 100,
  PAGINATION_MAX: 200,

  // ─── Auth crypto bounds ────────────────────────────────────────────────
  NONCE_MIN: 16,
  NONCE_MAX: 128,
  SIGNATURE_MIN: 40,
  SIGNATURE_MAX: 128,
} as const;
