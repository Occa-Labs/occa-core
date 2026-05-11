import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  integer,
  bigint,
  bigserial,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ── Users — one per Solana wallet ───────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletAddress: text("wallet_address").notNull().unique(),
  isPlatform: boolean("is_platform").notNull().default(false),
  // Device keypair persisted across probe + provision so the user only
  // approves OpenClaw pairing once. Cleared after successful provision —
  // the keypair lives on as agent.adapterConfig.deviceKeypair from then on.
  pendingDeviceKeypair: jsonb("pending_device_keypair"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Auth nonces — one-shot sign-in challenges ───────────────────────
export const authNonces = pgTable(
  "auth_nonces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull(),
    nonce: text("nonce").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_auth_nonces_wallet").on(t.walletAddress),
    index("idx_auth_nonces_expires_at").on(t.expiresAt),
  ],
);

// ── Companies / tenants — showcase (platform-owned) + user company ──
// Arsitektur §3: one-wallet-one-company (MVP), soft-delete via deleted_at,
// partial unique indexes enforce "satu showcase only" dan "satu active user company per owner".
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 'showcase' | 'user'
    kind: text("kind").notNull().default("user"),

    // ── Lifecycle state ──────────────────────────────────────────────
    // Paused (pakum) — workers + dispatcher skip companies with non-NULL
    // paused_at; UI surfaces a banner. Distinct from deletion: paused
    // companies can be resumed anytime without data loss.
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),

    // Kickoff lifecycle — drives the post-onboarding "CEO discovery → bulk
    // deploy" flow. Stays at 'not_started' until the user completes the
    // kickoff dialog; flips through 'provisioning' → 'completed'.
    kickoffState: text("kickoff_state").notNull().default("not_started"),
    kickoffStartedAt: timestamp("kickoff_started_at", { withTimezone: true }),
    kickoffCompletedAt: timestamp("kickoff_completed_at", {
      withTimezone: true,
    }),

    // ── On-chain Registry mirror (drizzle 0033 + 0034) ──────────────
    // Populated after `create_company` is confirmed on Solana. Source of
    // truth lives on-chain; these are cache columns for fast lookup.
    // NULL until the company has been registered on-chain.
    //
    // `owner_wallet` mirrors the on-chain `owner` field (= user wallet).
    // It IS the sole authority for state-changing instructions. The
    // operator hot wallet is fee-payer only and never appears in the
    // CompanyAccount layout.
    companyPda: text("company_pda").unique(),
    ownerWallet: text("owner_wallet"),
    chainNonce: integer("chain_nonce"),
    chainTxSignature: text("chain_tx_signature"),
    // Tier 1 mirror — match `CompanyAccount` fields not yet covered above.
    locale: text("locale"),
    // Tier 2 — pointer to canonical metadata JSON + sha256 hex of payload.
    metadataUri: text("metadata_uri"),
    metadataHash: text("metadata_hash"),
    // On-chain status: "active" | "paused". NULL until first chain sync.
    chainStatus: text("chain_status"),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_companies_owner").on(t.ownerUserId),
    uniqueIndex("uniq_showcase_singleton")
      .on(t.kind)
      .where(sql`kind = 'showcase'`),
    uniqueIndex("uniq_user_company_per_owner")
      .on(t.ownerUserId)
      .where(sql`kind = 'user' AND deleted_at IS NULL`),
  ],
);

// ── Company profile — 1:1 sibling of `companies` for brand / contact /
// crypto / audience metadata. Split out of `companies` because the parent
// table was bloated with ~30 marketing/identity fields rarely queried
// alongside the lifecycle state. Always read together via JOIN when the
// full profile is needed; lifecycle-only operations (kickoff state, pause)
// stay in `companies` and skip the JOIN.
export const companyProfile = pgTable("company_profile", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),

  // ── Identity / branding ──────────────────────────────────────────
  tagline: text("tagline"),
  logoUrl: text("logo_url"),
  niche: text("niche"),
  foundedAt: timestamp("founded_at", { withTimezone: false, mode: "string" }),

  // ── Editorial identity (Crypto Content & Research Studio core) ──
  coverageScope: text("coverage_scope"),
  coverageExcluded: text("coverage_excluded"),
  contentPillars: text("content_pillars")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  brandVoice: text("brand_voice"),
  forbiddenWords: text("forbidden_words")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),

  // ── Mission & audience ───────────────────────────────────────────
  mission: text("mission"),
  vision: text("vision"),
  targetAudience: text("target_audience"),
  usps: text("usps")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),

  // ── Output / services ────────────────────────────────────────────
  coreOffering: text("core_offering"),
  serviceCatalog: text("service_catalog")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),

  // ── Contact ──────────────────────────────────────────────────────
  contactEmail: text("contact_email"),
  salesEmail: text("sales_email"),
  phone: text("phone"),

  // ── Presence (web + social) ──────────────────────────────────────
  websiteUrl: text("website_url"),
  blogUrl: text("blog_url"),
  newsletterUrl: text("newsletter_url"),
  docsUrl: text("docs_url"),
  // jsonb of {twitter, linkedin, discord, telegram, github, mirror, ...}
  // — keep flexible since crypto-native platforms come and go
  socialHandles: jsonb("social_handles")
    .notNull()
    .default(sql`'{}'::jsonb`),

  // ── Crypto-native ────────────────────────────────────────────────
  treasuryAddress: text("treasury_address"),
  chainsCovered: text("chains_covered")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Company Brain (Tier 3) — filesystem-pattern knowledge store ────────
// Per-company persistent knowledge — glossary, ICP, do/don't, owner
// preferences, etc. Modeled after Anthropic Memory Tool: each row is a
// "file" with a path + content. Rationale (research 2026-05-11): Claude
// Memory Tool pattern beats KV blocks / vector DB / graph for OCCA's
// stack — Postgres-native, agent-self-edit-friendly via memory tool API,
// production-validated by Netflix/Rakuten with 97% error reduction.
//
// Visibility: `'all'` = every agent in company; `'ceo_only'` = CEO only
// (e.g. owner-preferences); `'tier:head'` = CEO + Heads (strategic intel).
// Filtering happens server-side at loadContext, before injection.
//
// Storage today: Postgres rows with path + content. Phase 2 may move to
// real filesystem / S3 / pgvector — schema is the same shape.
export const companyBrain = pgTable(
  "company_brain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Filesystem-style path, e.g. "/brain/glossary.md". Convention: lead
    // with "/brain/", end with ".md". Enforced at app layer rather than
    // DB so tests/migrations can use sentinel values without rewriting.
    path: text("path").notNull(),

    // Markdown body. No size cap at DB level — UI / loader enforces.
    content: text("content").notNull(),

    // Visibility tier — see header comment. Plain text instead of enum
    // for forward-compat (e.g. role-specific tiers later).
    visibility: text("visibility").notNull().default("all"),

    updatedBy: uuid("updated_by"), // user or deployment id (poly-ref)
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_company_brain_path").on(t.companyId, t.path),
    index("idx_company_brain_company").on(t.companyId),
  ],
);

// ── Documents (Tier 3b) — auto-saved task deliverables ─────────────────
// Every task that hits `status='done'` with a non-empty agent_result is
// auto-snapshotted into this table. Agents can reference completed work
// across sessions — "what did the team ship last week" or "find me a
// piece similar to the one Jhon wrote about AA" type queries.
//
// Immutable by design (no edit, no versioning). If the same task is
// re-dispatched and produces a new result, a new document row is created
// — we keep history. Task FK is nullable because tasks can be archived
// or deleted; documents survive.
//
// Retrieval today: tag filter + recency order. Phase 2 candidate for
// pgvector when total document count or token budget warrants it.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Originating task — nullable so deletion of task doesn't cascade
    // the document away. NULL also leaves room for non-task documents
    // later (manually saved snippets, owner-uploaded refs).
    taskId: uuid("task_id"),
    deploymentId: uuid("deployment_id"), // who produced it

    title: text("title").notNull(),
    content: text("content").notNull(), // markdown body
    format: text("format").notNull().default("markdown"),

    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_documents_company_created").on(t.companyId, t.createdAt),
    index("idx_documents_task").on(t.taskId),
  ],
);

// ── AgentIdentity — Truth tier mirror of on-chain `AgentIdentity` ─────
// Portable identity, owner-scoped, independent of any company. Same
// identity may be deployed to multiple companies owned by the same
// wallet. PDA seeds = ["agent_identity", agent_pubkey].
export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Stable identity key used as PDA seed (NOT the user wallet).
    agentPubkey: text("agent_pubkey").notNull().unique(),
    identityPda: text("identity_pda").notNull().unique(),
    // Mirrors on-chain `owner` — same wallet as `companies.owner_wallet`.
    ownerWallet: text("owner_wallet").notNull(),
    // Tier 1 on-chain field.
    name: text("name").notNull(),
    // Tier 2 metadata pointer + integrity hash (sha256 hex).
    metadataUri: text("metadata_uri"),
    metadataHash: text("metadata_hash"),
    chainTxSignature: text("chain_tx_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_agent_identities_owner").on(t.ownerUserId)],
);

// ── Deployment — Truth tier mirror of on-chain `Deployment` ───────────
// Per-company relation account between an AgentIdentity and a Company.
// PDA seeds = ["deployment", company_pda, deployment_index_le_u32].
// `deployment_index` is a per-company u32 counter chosen by the caller.
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentIdentityId: uuid("agent_identity_id")
      .notNull()
      .references(() => agentIdentities.id, { onDelete: "cascade" }),
    deploymentPda: text("deployment_pda").notNull().unique(),
    // Per-company u32 counter — mirrors PDA seed.
    deploymentIndex: integer("deployment_index").notNull(),
    // Capability persona (e.g. "ceo", "sdr"). NOT a job title — see §15.7.
    role: text("role").notNull(),
    // Reporting parent within this company (NULL = top-level). On-chain
    // this is `Option<u32>` keyed by deployment_index; in DB we mirror
    // the index for portability across reseed.
    parentDeploymentIndex: integer("parent_deployment_index"),
    // Pinned adapter pubkey. `Pubkey::default()` on-chain → NULL here.
    adapterId: text("adapter_id"),
    // Optional user-supplied transactional wallet. NULL = unset
    // (on-chain shows `Pubkey::default()`).
    operatingWallet: text("operating_wallet"),
    // On-chain status: "active" | "paused" | "retired" (text encoding of
    // the u8 enum 0/1/2). Retired is terminal.
    status: text("status").notNull().default("active"),
    // Tier 2 metadata.
    metadataUri: text("metadata_uri"),
    metadataHash: text("metadata_hash"),
    chainTxSignature: text("chain_tx_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_deployments_company").on(t.companyId),
    index("idx_deployments_identity").on(t.agentIdentityId),
    // Mirrors PDA seed uniqueness.
    uniqueIndex("uniq_deployments_company_index").on(
      t.companyId,
      t.deploymentIndex,
    ),
  ],
);

// ── Agent runtime profile — Ephemeral tier (1:1 with deployments) ─────
// Adapter config, provisioning state, 3D seating — none of these live
// on-chain. Recovery flow regenerates these from defaults; on-chain
// recovery only restores `deployments` + `agent_identities`.
//
// adapter_config stored as plaintext JSONB for now. TODO encrypt at
// rest per arsitektur §4.1 before real gateway credentials land here.
export const agentRuntimeProfile = pgTable(
  "agent_runtime_profile",
  {
    deploymentId: uuid("deployment_id")
      .primaryKey()
      .references(() => deployments.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Derived from `deployments.adapter_id` (resolved to adapter package
    // type at provision time). Cached for fast lookups in worker.
    adapterType: text("adapter_type").notNull(),
    adapterConfig: jsonb("adapter_config").notNull(),
    externalAgentId: text("external_agent_id"),
    desiredSkills: text("desired_skills")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    skillsInitializedAt: timestamp("skills_initialized_at", {
      withTimezone: true,
    }),
    // Background provisioning state for the kickoff async flow.
    // 'pending' → 'ready' | 'failed'.
    provisioningState: text("provisioning_state").notNull().default("ready"),
    provisioningError: text("provisioning_error"),
    // Stable 3D office anchor ID. Assigned once at deploy time and
    // persisted forever — frontend looks this up against `office-anchors.ts`.
    workstationId: text("workstation_id"),
    // Optional override for the 3D character model.
    modelOverride: text("model_override"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_agent_runtime_profile_company").on(t.companyId),
    uniqueIndex("uniq_agent_runtime_profile_workstation")
      .on(t.companyId, t.workstationId)
      .where(sql`${t.workstationId} IS NOT NULL`),
  ],
);

// ── Company skills — central catalog ───────────────────────────────
// GitHub-only Phase 2B. Only SKILL.md markdown is stored in DB; non-SKILL.md
// files are streamed on-demand from raw.githubusercontent.com pinned to
// source_ref (commit SHA) for reproducibility.
export const companySkills = pgTable(
  "company_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL = platform built-in, shared across all companies.
    // Non-NULL = per-company custom import.
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(), // canonical: "owner/repo/slug"
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    markdown: text("markdown").notNull(),
    sourceType: text("source_type").notNull(), // "github" only Phase 2B
    sourceLocator: text("source_locator").notNull(),
    sourceRef: text("source_ref").notNull(), // commit SHA
    sourceOwner: text("source_owner").notNull(),
    sourceRepo: text("source_repo").notNull(),
    sourcePath: text("source_path").notNull(), // path in repo to skill dir
    fileInventory: jsonb("file_inventory")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Empty array = unrestricted (all roles). Non-empty = whitelist of agent
    // roles allowed to bind this skill. Admin-controlled at import time.
    allowedRoles: text("allowed_roles")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_company_skills_company").on(t.companyId),
    // Built-in: globally unique key when company_id is NULL.
    uniqueIndex("uniq_builtin_skill_key")
      .on(t.key)
      .where(sql`${t.companyId} IS NULL`),
    // Custom: per-company unique key when company_id is set.
    uniqueIndex("uniq_company_skill_key")
      .on(t.companyId, t.key)
      .where(sql`${t.companyId} IS NOT NULL`),
  ],
);

// ── Tasks — kanban work units, user-created Phase 2A ─────────────────
// blocks = ContentBlock[] (paragraph/heading/bullet/checklist/quote/code/divider).
// assignedAgentId nullable FK; set_null on agent delete. dueDate optional.
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Per-company monotonically increasing ID shown in UI (e.g. #12).
    // Uuid stays the authoritative key; number is the human-readable handle.
    taskNumber: integer("task_number").notNull(),
    assignedDeploymentId: uuid("assigned_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    // Self-FK for parent/child task graph (autonomy L2 — child completion
    // wakes the parent). Null for top-level / user-created tasks.
    parentTaskId: uuid("parent_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    // Tasks this one is waiting on. When the agent emits a BLOCK action
    // it lists task ids it can't proceed without. Cascade unblocks (and
    // re-wakes the assignee) when all entries here transition to `done`.
    blockedByTaskIds: uuid("blocked_by_task_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    // Set when a task is born from an agent action (currently: an approved
    // delegate request). Null for user-created tasks. `createdByUserId` and
    // `createdByAgentId` are mutually exclusive — exactly one should be set.
    createdByDeploymentId: uuid("created_by_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    // Delegation contract — what "done" means for this task. Set when the
    // task was created via DELEGATE so the assignee knows the bar.
    acceptanceCriteria: text("acceptance_criteria"),
    title: text("title").notNull(),
    blocks: jsonb("blocks")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("medium"),
    // Notion-style single-select. Describes the shape of the work
    // (research/docs/code/etc) — separate axis from free-form tags.
    taskType: text("task_type").notNull().default("other"),
    // T-shirt sizing. Used for rough effort estimation; feeds budget UI later.
    effortLevel: text("effort_level").notNull().default("m"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    dueDate: timestamp("due_date", { withTimezone: true }),
    linkedTraceId: uuid("linked_trace_id"),
    // Nullable now: tasks created by agents (via approved DELEGATE) have
    // `createdByAgentId` set instead. Either one or the other is non-null.
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    // Soft-archive — non-null timestamp = task is shelved (different from
    // `done`, which means completed). Hidden from default board, opt-in
    // visibility via "Show archived" toggle. Reversible (set to null to
    // unarchive). Free-text reason captured at archive time for context.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveReason: text("archive_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_tasks_company_status").on(t.companyId, t.status),
    uniqueIndex("uniq_tasks_company_number").on(t.companyId, t.taskNumber),
    // Default-board lookups always filter `archived_at IS NULL`. Partial
    // index covers that path without bloating size on archived rows.
    index("idx_tasks_company_active")
      .on(t.companyId, t.status)
      .where(sql`archived_at IS NULL`),
  ],
);

// ── Traces — per-agent execution records ──────────────────────────────
// Each trace represents one invocation of adapter.executeTrace(). Self-ref
// retryOfTraceId chains continuation traces back to their source.
export const traces = pgTable(
  "traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    actorType: text("actor_type"), // "user" | "agent" | "system"
    actorId: text("actor_id"),
    wakePayload: jsonb("wake_payload"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    retryOfTraceId: uuid("retry_of_trace_id").references(
      (): AnyPgColumn => traces.id,
      { onDelete: "set null" },
    ),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    error: text("error"),
    errorCode: text("error_code"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logSha256: text("log_sha256"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processLossRetryCount: integer("process_loss_retry_count")
      .notNull()
      .default(0),
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    nextAction: text("next_action"),
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    failureRetryAttempt: integer("failure_retry_attempt").notNull().default(0),
    retryReason: text("retry_reason"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    lastUsefulActionAt: timestamp("last_useful_action_at", {
      withTimezone: true,
    }),
    contextSnapshot: jsonb("context_snapshot"),
    usageJson: jsonb("usage_json"),
    resultJson: jsonb("result_json"),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    externalTraceId: text("external_trace_id"),
    conversationId: text("conversation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("traces_conversation_id_idx").on(t.conversationId),
    index("traces_company_deployment_started_idx").on(
      t.companyId,
      t.deploymentId,
      t.startedAt,
    ),
    index("traces_company_liveness_idx").on(
      t.companyId,
      t.livenessState,
      t.createdAt,
    ),
    index("traces_status_created_idx").on(t.status, t.createdAt),
  ],
);

// ── Trace events — per-trace event stream (chunks, tool calls) ────────
export const traceEvents = pgTable(
  "trace_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    stream: text("stream"),
    level: text("level"),
    color: text("color"),
    message: text("message"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("trace_events_trace_seq_idx").on(t.traceId, t.seq),
    index("trace_events_company_trace_idx").on(t.companyId, t.traceId),
    index("trace_events_company_created_idx").on(t.companyId, t.createdAt),
  ],
);

// ── Task events — per-task append-only timeline (EventStream) ─────────
// Unified log of everything that happens to a task: status changes, trace
// lifecycle, comments, agent actions. Append-only; no UPDATE/DELETE in
// application code. Powers timeline UI, audit, and future workflow engine.
// Runs alongside `traces` / `traceEvents` / `taskComments` — existing reads
// stay on those tables; new consumers read here.
export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // Per-task monotonic counter, generated server-side inside append helper.
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    // 'user' | 'agent' | 'system'
    actorType: text("actor_type").notNull(),
    // userId / deploymentId / 'system' — string to accommodate all three.
    actorId: text("actor_id"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    traceId: uuid("trace_id").references((): AnyPgColumn => traces.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_task_events_task_seq").on(t.taskId, t.sequence),
    index("idx_task_events_task_type").on(t.taskId, t.eventType),
    index("idx_task_events_company_created").on(t.companyId, t.createdAt),
  ],
);

// ── Agent action idempotency — dedupe POST /me/actions/emit replays ────
// Agents retrying a failed HTTP action (network blip, dispatcher restart)
// must produce the same resource exactly once. Caller supplies an
// idempotencyKey unique per (deployment, actionType); we cache the result
// id so retries return it without re-running the side-effect.
export const agentActionIdempotency = pgTable(
  "agent_action_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references((): AnyPgColumn => deployments.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    // Generic result pointer — taskId for EmitFollowUp, commentId for
    // RequestInfo. Type-tagged so future actions can reuse the table.
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_agent_action_idempotency").on(
      t.deploymentId,
      t.actionType,
      t.idempotencyKey,
    ),
  ],
);

// ── Deployment task sessions — adapter resume handles per (deployment, task) ──
// Stores opaque sessionParams so an adapter can resume a prior
// conversation/session rather than starting fresh on each run.
export const deploymentTaskSessions = pgTable(
  "deployment_task_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    taskKey: text("task_key").notNull(), // "task:<uuid>"
    sessionParamsJson: jsonb("session_params_json"),
    sessionDisplayId: text("session_display_id"),
    lastTraceId: uuid("last_trace_id").references(() => traces.id, {
      onDelete: "set null",
    }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex(
      "deployment_task_sessions_company_deployment_adapter_task_uniq",
    ).on(t.companyId, t.deploymentId, t.adapterType, t.taskKey),
    index("deployment_task_sessions_company_deployment_updated_idx").on(
      t.companyId,
      t.deploymentId,
      t.updatedAt,
    ),
    index("deployment_task_sessions_company_task_updated_idx").on(
      t.companyId,
      t.taskKey,
      t.updatedAt,
    ),
  ],
);

// ── Deployment runtime state — per-deployment counters + last run pointer ──
export const deploymentRuntimeState = pgTable("deployment_runtime_state", {
  deploymentId: uuid("deployment_id")
    .primaryKey()
    .references(() => deployments.id, { onDelete: "cascade" }),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  stateJson: jsonb("state_json")
    .notNull()
    .default(sql`'{}'::jsonb`),
  sessionId: text("session_id"),
  totalInputTokens: bigint("total_input_tokens", { mode: "number" })
    .notNull()
    .default(0),
  totalOutputTokens: bigint("total_output_tokens", { mode: "number" })
    .notNull()
    .default(0),
  totalCachedInputTokens: bigint("total_cached_input_tokens", {
    mode: "number",
  })
    .notNull()
    .default(0),
  totalCostCents: bigint("total_cost_cents", { mode: "number" })
    .notNull()
    .default(0),
  lastTraceId: uuid("last_trace_id"),
  lastTraceStatus: text("last_trace_status"),
  lastError: text("last_error"),
  connectionState: text("connection_state").notNull().default("unknown"),
  connectionCheckedAt: timestamp("connection_checked_at", {
    withTimezone: true,
  }),
  connectionError: text("connection_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── Routines — scheduled work declarations ────────────────────────────
// A routine declares recurring work; a trigger carries the cron expression;
// a run records each firing. Timer wakes come from here, not per-agent cron.
export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    goalId: uuid("goal_id"),
    parentIssueId: uuid("parent_issue_id"),
    title: text("title").notNull(),
    description: text("description"),
    assigneeDeploymentId: uuid("assignee_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("active"),
    concurrencyPolicy: text("concurrency_policy")
      .notNull()
      .default("coalesce_if_active"),
    catchUpPolicy: text("catch_up_policy").notNull().default("skip_missed"),
    variables: jsonb("variables"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_routines_company").on(t.companyId),
    index("idx_routines_assignee").on(t.assigneeDeploymentId),
  ],
);

export const routineTriggers = pgTable(
  "routine_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "cron" | "webhook" | "manual"
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    timezone: text("timezone"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    publicId: text("public_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_routine_triggers_routine").on(t.routineId),
    index("idx_routine_triggers_enabled_next").on(t.enabled, t.nextRunAt),
  ],
);

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").references(() => routineTriggers.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(), // "cron" | "webhook" | "manual"
    status: text("status").notNull(), // "pending" | "enqueued" | "coalesced" | "failed"
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key"),
    triggerPayload: jsonb("trigger_payload"),
    linkedIssueId: uuid("linked_issue_id"),
    coalescedIntoTraceId: uuid("coalesced_into_trace_id"),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_routine_runs_routine_triggered").on(t.routineId, t.triggeredAt),
    uniqueIndex("uniq_routine_runs_idem")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

// ── Deployment API keys — hashed, revocable, per-deployment auth ─────
// Raw key shown once at creation; stored hashed (sha256). The adapter
// receives the raw key via AdapterExecutionContext.runtimeEnv.apiKey at
// wake time and uses it to call OCCA server endpoints.
export const deploymentApiKeys = pgTable(
  "deployment_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_deployment_api_keys_deployment").on(t.deploymentId),
    index("idx_deployment_api_keys_company").on(t.companyId),
  ],
);

// ── Approvals — agent-requested actions gated on user decision ───────
// Generic approval record. Extend action_type
// vocabulary when sign_tx / spend / destructive ops join the gate later.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    requestedByDeploymentId: uuid("requested_by_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    actionType: text("action_type").notNull(),
    // Opaque payload — structure depends on actionType.
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"), // pending|approved|rejected|cancelled
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_approvals_company_status").on(t.companyId, t.status),
    index("idx_approvals_deployment").on(t.requestedByDeploymentId),
  ],
);

// ── Deployment workspace files — OCCA-authored per-deployment markdown ─
// Files live here as source of truth; OpenClaw holds a projection pushed
// via `agents.files.set`. On deploy, one row per file is inserted from
// rendered templates (see apps/server/src/onboarding-assets/<role>/).
export const deploymentWorkspaceFiles = pgTable(
  "deployment_workspace_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Filename inside the OpenClaw workspace root (no leading slash).
    // Canonical set: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md,
    // HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md. We don't constrain to an enum
    // because later file types (BOOT.md, per-day memory entries) will
    // land in the same table.
    filename: text("filename").notNull(),
    content: text("content").notNull(),
    // "template" = rendered from onboarding-assets on create. "user_edit" =
    // modified via UI. "agent_write" reserved for future runtime sync when
    // the agent itself pushes changes back to OCCA.
    source: text("source").notNull().default("template"),
    // Records which template was rendered. Format: "<role>/<filename>" or
    // "default/<filename>" depending on which fallback tier was used. NULL
    // for pure user_edit rows that were never template-based.
    templateOrigin: text("template_origin"),
    // Timestamp of the last successful push to OpenClaw via
    // `agents.files.set`. NULL means we have local content newer than the
    // remote copy (or we never synced yet). Drives a future re-sync job.
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_deployment_workspace_file_name").on(
      t.deploymentId,
      t.filename,
    ),
    index("idx_deployment_workspace_files_company").on(t.companyId),
  ],
);

// ── Deployment skill syncs — per-deployment-per-skill install tracking ─
// Background worker reads pending/failed rows and sends install/uninstall
// prompts via the OpenClaw gateway. State machine:
//   pending → installing → installed | failed.
export const deploymentSkillSyncs = pgTable(
  "deployment_skill_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Canonical skill key: "owner/repo/slug"
    skillKey: text("skill_key").notNull(),
    // pending | installing | installed | failed
    status: text("status").notNull().default("pending"),
    // install | uninstall | reinstall
    action: text("action").notNull().default("install"),
    // sourceRef (commit SHA) at time of last successful install.
    // Compared against companySkills.sourceRef to detect outdated status.
    skillRef: text("skill_ref"),
    // GitHub tree URL sent to the agent on last prompt.
    skillUrl: text("skill_url"),
    // Gateway runId returned by the initial "agent" RPC. Stored so subsequent
    // ticks can call agent.wait to check completion without re-sending the prompt.
    gatewayRunId: text("gateway_run_id"),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_deployment_skill_sync").on(t.deploymentId, t.skillKey),
    index("idx_deployment_skill_syncs_status").on(t.status),
    index("idx_deployment_skill_syncs_company").on(t.companyId),
  ],
);

// ── Task comments — agent-to-agent + user-to-agent thread per task ───
// Authored by either an agent (authorAgentId) or a human user
// (authorUserId) — exactly one is non-null. `mentions` carries the
// resolved agent UUIDs parsed from `@agent-name` in the body. The
// dispatcher routes wakes to mentioned agents on insert, so the
// frontend only needs to render the thread; the wake side-effect is
// server-driven.
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    authorDeploymentId: uuid("author_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    mentions: uuid("mentions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_task_comments_task").on(t.taskId),
    index("idx_task_comments_company_created").on(t.companyId, t.createdAt),
  ],
);

// ── Workflows — auto follow-up rules (per-company) ────────────────────
// Hooks that fire on `task.completed` events; the workflow engine (Phase
// 6, not yet built) reads these and decides whether to spawn child
// tasks. `yamlText` is the canonical editable form; `parsedDefinition`
// is the validated jsonb cache, written atomically with yamlText so they
// can never disagree. Slug (`yamlId`) is unique per company so users can
// reference workflows by stable id from prompts / runtime.
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    yamlId: text("yaml_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    yamlText: text("yaml_text").notNull(),
    parsedDefinition: jsonb("parsed_definition").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_workflows_company_yaml_id").on(t.companyId, t.yamlId),
    index("idx_workflows_company_enabled").on(t.companyId, t.enabled),
  ],
);

// ── Chat messages — user ↔ deployment (CEO) conversational thread ─────
// Phase 2.5 of the hierarchical agent system: the user's only entry surface
// is a real chat with the CEO. Each turn (user prompt + agent reply) lands
// here as one row. CEO can clarify ambiguity over multiple turns and emits
// `[[OCCA:CREATE_TASK]]` markers when scope is agreed; the marker is
// stripped from `content` before persist and the spawned task id stored on
// `createdTaskId` for audit.
//
// One thread per (companyId, deploymentId). Today only CEO is a chat
// target, but the schema is target-agnostic so a future "DM any agent"
// feature reuses the same table.
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    // 'user' | 'assistant' | 'system'. System messages mark internal
    // events the user should see ("Task #5 created").
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Set on assistant messages whose CREATE_TASK marker spawned a task.
    // Lets the UI link "this reply" → "the task that was created".
    createdTaskId: uuid("created_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    // Trace row for the adapter call that produced an assistant turn.
    // Null on user / system messages.
    traceId: uuid("trace_id").references(() => traces.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_chat_messages_thread").on(
      t.companyId,
      t.deploymentId,
      t.createdAt,
    ),
  ],
);
