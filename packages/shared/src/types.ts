import type {
  agentIdentities,
  agentRuntimeProfile,
  approvals,
  authNonces,
  chatMessages,
  companies,
  companyProfile,
  companySkills,
  deploymentApiKeys,
  deploymentRuntimeState,
  deploymentSkillSyncs,
  deploymentTaskSessions,
  deployments,
  routineRuns,
  routineTriggers,
  routines,
  taskComments,
  tasks,
  traceEvents,
  traces,
  users,
} from "./schema";

export type User = typeof users.$inferSelect;
export type AuthNonce = typeof authNonces.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyProfile = typeof companyProfile.$inferSelect;
export type AgentIdentity = typeof agentIdentities.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type AgentRuntimeProfile = typeof agentRuntimeProfile.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type CompanySkill = typeof companySkills.$inferSelect;
export type Trace = typeof traces.$inferSelect;
export type TraceEvent = typeof traceEvents.$inferSelect;
export type DeploymentTaskSession = typeof deploymentTaskSessions.$inferSelect;
export type DeploymentRuntimeStateRow =
  typeof deploymentRuntimeState.$inferSelect;
export type Routine = typeof routines.$inferSelect;
export type RoutineTrigger = typeof routineTriggers.$inferSelect;
export type RoutineRun = typeof routineRuns.$inferSelect;
export type DeploymentApiKey = typeof deploymentApiKeys.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type DeploymentSkillSync = typeof deploymentSkillSyncs.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

// ── Chat (Phase 2.5) — user ↔ CEO conversational thread ─────────────────
// Mirror of `chat_messages` row sans server-only fields. The `pendingTask`
// flag is set on the in-flight assistant turn so the UI can render a
// "thinking…" placeholder while the server is still awaiting the gateway.
export type ChatMessageRole = "user" | "assistant" | "system";

// Minimal slice of an approval embedded on a chat message so the chat can
// render an inline Approve/Reject card. The full record lives in the
// Approvals window (pending + history); this is just enough to render +
// decide inline.
export interface ChatLinkedApproval {
  id: string;
  actionType: ApprovalActionType;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
}

export interface ChatMessageDTO {
  id: string;
  role: ChatMessageRole;
  content: string;
  /** Set on assistant messages whose CREATE_TASK marker spawned a task. */
  createdTaskId: string | null;
  /** Set on assistant messages whose with-approval marker created a pending
   *  approval. Drives the inline Approve/Reject card in chat. The approval
   *  row is still the canonical record in the Approvals window. */
  linkedApproval: ChatLinkedApproval | null;
  /** Token/cost this turn spent, from the assistant message's trace. Null on
   *  user/system messages and on assistant turns whose adapter reported no
   *  usage. Drives the per-bubble cost line + the thread running total. */
  usage: TraceUsage | null;
  createdAt: string;
}

export interface SendChatMessageRequest {
  content: string;
}

export interface SendChatMessageResponse {
  /** The persisted user turn. */
  user: ChatMessageDTO;
  /** The CEO's reply (or null if the adapter call failed; the route still
   *  returns 200 with a system error message in that case). */
  assistant: ChatMessageDTO | null;
  /** When the reply emitted CREATE_TASK, this carries the new task id +
   *  number so the UI can deep-link into the task board. */
  createdTask: { id: string; taskNumber: number; title: string } | null;
}

export interface ListChatMessagesResponse {
  messages: ChatMessageDTO[];
}

// ── Chat Inbox (Chats window) ─────────────────────────────────────────
// Observer-style view across both `user_ceo` and `agent_dm` threads,
// grouped by (self, partner) pair so multiple threads with the same
// counterpart collapse into one inbox row. See `chat-inbox.ts` repo for
// the aggregation contract.
export type InboxPartyKind = "user" | "deployment";
export type InboxThreadKind = "user_ceo" | "agent_dm";

export interface InboxPartySummaryDTO {
  kind: InboxPartyKind;
  /** userId when kind="user", deploymentId when kind="deployment". */
  id: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageRole: ChatMessageRole;
  /** Number of distinct threads collapsed into this partner row. */
  threadCount: number;
}

export interface ListInboxPartnersResponse {
  partners: InboxPartySummaryDTO[];
}

export interface InboxMessageDTO {
  id: string;
  threadId: string;
  threadKind: InboxThreadKind;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  /** Resolved sender — derived from thread metadata + message role so the
   *  UI can align bubbles without knowing thread semantics. */
  senderKind: InboxPartyKind;
  senderId: string;
  createdTaskId: string | null;
}

export interface ListInboxMessagesResponse {
  messages: InboxMessageDTO[];
}

// ── Heartbeat policy — stored inside agents.runtimeConfig.heartbeat ──
// Read with `runtimeConfig.heartbeat ?? defaults`.
export interface HeartbeatConfig {
  enabled: boolean;
  intervalSec: number;
  wakeOnAssignment: boolean;
  wakeOnOnDemand: boolean;
  wakeOnAutomation: boolean;
  cooldownSec: number;
}

export const defaultHeartbeatConfig: HeartbeatConfig = {
  enabled: true,
  intervalSec: 300,
  wakeOnAssignment: true,
  wakeOnOnDemand: true,
  wakeOnAutomation: true,
  cooldownSec: 10,
};

// ── JWT payload shape (mirrored between server signer + web verifier) ──
export interface AuthTokenPayload {
  userId: string;
  walletAddress: string;
  iat?: number;
  exp?: number;
}

// ── Public-facing user shape (API responses) ──
export interface AuthUser {
  id: string;
  walletAddress: string;
  // Optional self-set display name. NULL/empty = unset (UI falls back to
  // the wallet address).
  name: string | null;
  isPlatform: boolean;
  createdAt: string;
}

// ── Company DTO sent to client ──
export interface CompanyDTO {
  id: string;
  name: string;
  kind: "user" | "showcase";
  createdAt: string;

  // Identity / branding
  tagline: string | null;
  logoUrl: string | null;
  niche: string | null;
  foundedAt: string | null; // ISO date

  // Editorial identity
  coverageScope: string | null;
  coverageExcluded: string | null;
  contentPillars: string[];
  brandVoice: string | null;
  forbiddenWords: string[];

  // Mission & audience
  mission: string | null;
  vision: string | null;
  targetAudience: string | null;
  usps: string[];

  // Output / services
  coreOffering: string | null;
  serviceCatalog: string[];

  // Contact
  contactEmail: string | null;
  salesEmail: string | null;
  phone: string | null;

  // Presence
  websiteUrl: string | null;
  blogUrl: string | null;
  newsletterUrl: string | null;
  docsUrl: string | null;
  socialHandles: Record<string, string>;

  // Crypto-native
  treasuryAddress: string | null;
  chainsCovered: string[];

  // Operations — operator-domain monthly token-spend pool (US cents).
  // Covers all token-consuming activity (tasks + chat). Not a per-run cap;
  // gates the start of new work once month-to-date spend reaches it.
  monthlyBudgetCents: number;

  // Task settings — how many times a Head reviews a delegated deliverable
  // before the auto-reviewer auto-rejects. Operator-tunable; default 2.
  maxReviewRounds: number;
  // Research depth target in the task prompt — ~this many searches + fetches
  // before the agent must stop gathering and write. Operator-tunable; default 6.
  researchBudget: number;

  // State
  pausedAt: string | null;
  pausedReason: string | null;

  // Kickoff lifecycle
  kickoffState: KickoffState;
  kickoffStartedAt: string | null;
  kickoffCompletedAt: string | null;

  // ── On-chain Registry mirror ───────────────────────────────────────
  // Populated after `create_company` confirms on Solana. NULL until the
  // company has been anchored.
  //
  // `ownerWallet` mirrors the on-chain `owner` field — the user wallet
  // that signed the create. It IS the sole authority for state-changing
  // ix on this CompanyAccount.
  companyPda: string | null;
  ownerWallet: string | null;
  chainNonce: number | null;
  chainTxSignature: string | null;
}

export type KickoffState = "not_started" | "provisioning" | "completed";

// PATCH body for company updates. Every field is optional — caller sends
// only what they're changing. `null` clears a field; omitting leaves it.
export interface UpdateCompanyRequest {
  name?: string;
  tagline?: string | null;
  logoUrl?: string | null;
  niche?: string | null;
  foundedAt?: string | null;
  coverageScope?: string | null;
  coverageExcluded?: string | null;
  contentPillars?: string[];
  brandVoice?: string | null;
  forbiddenWords?: string[];
  mission?: string | null;
  vision?: string | null;
  targetAudience?: string | null;
  usps?: string[];
  coreOffering?: string | null;
  serviceCatalog?: string[];
  contactEmail?: string | null;
  salesEmail?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
  blogUrl?: string | null;
  newsletterUrl?: string | null;
  docsUrl?: string | null;
  socialHandles?: Record<string, string>;
  treasuryAddress?: string | null;
  chainsCovered?: string[];
  monthlyBudgetCents?: number;
  maxReviewRounds?: number;
  researchBudget?: number;
}

export interface PauseCompanyRequest {
  reason?: string | null;
}

// Aggregated stats shown in the Company window header.
export interface CompanyStats {
  agentsCount: number;
  tasksCount: number;
  // Reserved for future Company Brain integration.
  memoryEntriesCount: number;
  // Month-to-date token spend (US cents) summed live from trace usage —
  // the draw-down against `monthlyBudgetCents`. Resets each calendar month.
  budgetSpentCents: number;
}

export interface CompanyResponse {
  company: CompanyDTO;
  stats: CompanyStats;
}

// ── Agent status surfaces ──
export type AgentActivityState = "idle" | "working" | "cooldown" | "error";

export type AgentConnectionState = "connected" | "disconnected" | "unknown";

// ── Agent DTO sent to client ──
export interface AgentDTO {
  id: string;
  /** UUID of the underlying `agent_identities` row (one identity may
   *  back multiple deployments). Surfaced so chain flows can call the
   *  identity-scoped routes (`/api/chain/agent-identities/:identityId/...`)
   *  without an extra lookup. */
  identityId: string;
  /** Company the agent currently works at, or null = idle/available
   *  (not assigned to any company). */
  companyId: string | null;
  name: string;
  /** Free-text specialty / persona ("specialist for X"). Intrinsic to the
   *  agent identity; null when unset. */
  persona: string | null;
  /** Owner opt-in: listed in the cross-owner agent marketplace so other
   *  companies can invite it. */
  availableForWork: boolean;
  /** Whether the portable AgentIdentity is registered on-chain
   *  (agent_identities.chain_tx_signature). Distinct from
   *  agentChainTxSignature, which is the per-deployment (Phase C) anchor.
   *  Marketplace eligibility gates on THIS. */
  identityAnchored: boolean;
  /** The agent's personal on-chain receiving wallet (intrinsic to the
   *  identity). null = unset. Marketplace listing requires it set. */
  receivingWallet: string | null;
  role: string;
  adapterType: string;
  externalAgentId: string | null;
  desiredSkills: string[];
  // Per-agent tool whitelist (company_tools.id values). Drives the
  // /api/me/agent/tools discovery filter alongside the tool's own
  // allowed_roles gate. Empty array = no tools available.
  enabledTools: string[];
  // Reports-to / manager link. NULL = top-level (typically the CEO,
  // reporting to the human owner). Drives the delegate-approval scope
  // rule: an agent may only delegate to targets inside its own subtree.
  parentAgentId: string | null;
  createdAt: string;
  activityState: AgentActivityState;
  activityTraceId: string | null;
  connectionState: AgentConnectionState;
  connectionCheckedAt: string | null;
  connectionError: string | null;
  // Background provisioning state — populated by the kickoff async flow.
  // 'ready' for any agent created via the direct deploy route.
  provisioningState: AgentProvisioningState;
  provisioningError: string | null;
  // 3D office seat anchor ID. Stable per agent — assigned once at deploy
  // time. NULL only for legacy rows pre-migration; the frontend falls
  // back to a hash-based pick from FALLBACK_WORKSTATIONS when null.
  workstationId: string | null;
  // Optional override for the 3D character model. NULL = auto-pick via
  // claim-and-skip. Non-NULL = pinned GLB url.
  modelOverride: string | null;

  // Flat amount (lamports) invoiced to the company each time this agent
  // completes a task. NULL = rate not set; no invoice is auto-created
  // until the operator configures one. Off-chain operational config —
  // not mirrored on-chain.
  taskRateLamports: number | null;

  // Lifecycle status mirrored from `deployments.status`. "active" =
  // dispatchable + visible in CEO's active team; "paused" = excluded
  // from active-team filters but reversible; "retired" = archived,
  // no longer dispatchable. CLAUDE.md regulatory naming forbids
  // "fired"/"terminated" labels for this state.
  status: AgentDeploymentStatus;

  // ── On-chain Registry mirror ───────────────────────────────────────
  // Populated after `register_agent` confirms on Solana.
  //
  // `ownerWallet` = user wallet (same as company.ownerWallet). Sole
  // signer for state-changing ix on this AgentAccount.
  //
  // `receivingAddress` = optional user-supplied transactional wallet.
  // NULL = not set yet (on-chain shows Pubkey::default()).
  agentPda: string | null;
  agentIndex: number | null;
  ownerWallet: string | null;
  receivingAddress: string | null;
  agentChainTxSignature: string | null;
}

export type AgentProvisioningState = "pending" | "ready" | "failed";

// Deployment lifecycle status. Matches `deployments.status` column.
// Per CLAUDE.md regulatory naming: use "retired" not "fired".
export type AgentDeploymentStatus = "active" | "paused" | "retired";

// ── Agent mutations ────────────────────────────────────────────────
export interface UpdateAgentRequest {
  name?: string;
  role?: AgentRole;
  adapterConfig?: AdapterConfig;
  // Pass `null` to detach (becomes top-level). Server validates that the
  // new parent is in the same company and not a descendant of this agent
  // (prevents cycles).
  parentAgentId?: string | null;
  // Manual seat reassignment. Slug must match an anchor in ALL_DESKS
  // (shared/seating). Reserved-zone desks (meeting/lobby/exec) are
  // intentionally allowed for manual placement; auto-assign skips them.
  workstationId?: string;
  // Pass `null` to clear (revert to auto-pick). Pass a GLB url string to
  // pin the agent to that character model.
  modelOverride?: string | null;
  // Flat per-task invoice amount in lamports. Pass `null` to clear (no
  // auto-invoicing). Off-chain operational config — DB write only.
  taskRateLamports?: number | null;
}

export interface SyncAgentSkillsRequest {
  desiredSkills: string[];
}

// Replace the agent's `enabled_tools` array. UUIDs must reference tools
// owned by the same company; backend rejects with TOOL_NOT_FOUND otherwise.
export interface SyncAgentToolsRequest {
  enabledTools: string[];
}

export interface AgentResponse {
  agent: AgentDTO;
}

// ── GET /api/me ──
export interface MeResponse {
  user: AuthUser;
  company: CompanyDTO | null;
  agents: AgentDTO[];
}

// Cross-owner marketplace listing — a public, lightweight view of an
// available agent (owned by someone else). No internal/operational fields.
export interface MarketplaceAgentDTO {
  identityId: string;
  name: string;
  persona: string | null;
  role: string;
  ownerWallet: string;
  // On-chain identity PDA — links to the block explorer as proof the
  // agent is anchored (not just a DB row).
  identityPda: string;
  // The agent's personal on-chain receiving wallet. Always present for
  // marketplace listings (the query requires it set).
  receivingWallet: string;
  // True when the viewer owns this agent — listed for visibility, but the
  // invite action is suppressed (can't cross-owner invite yourself).
  isOwn: boolean;
  createdAt: string;
}

export interface MarketplaceAgentsResponse {
  agents: MarketplaceAgentDTO[];
}

export type InviteStatus = "pending" | "accepted" | "rejected" | "cancelled";

// An incoming cross-owner hire invite, shown in the agent owner's inbox.
// The inbox keeps resolved invites as history, so `status` + `updatedAt`
// (when the decision landed) ride along with each row.
export interface MarketplaceInviteDTO {
  id: string;
  companyName: string;
  agentName: string;
  targetIdentityId: string;
  role: string;
  status: InviteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceInvitesResponse {
  invites: MarketplaceInviteDTO[];
}

// ── Agent role — open vocabulary ────────────────────────────────────
// Role is a normalized slug (lowercase; [a-z0-9_-]). The canonical catalog
// (with labels, descriptions, default names, seating zones) lives in
// `role-catalog.ts`. The slug type is open-vocab — agents can have any
// regex-valid role string, not just catalog entries.
export type AgentRole = string;
export const ROLE_SLUG_PATTERN = /^[a-z0-9_-]+$/;
export const ROLE_SLUG_MAX = 32;

// ── Adapter types ──
// Order = display order in any "pick an adapter" UI. Keep openclaw first
// as the default-rendered card until usage data says otherwise.
export const ADAPTER_TYPES = ["openclaw", "hermes", "claude-code"] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

// Narrow an arbitrary string to a registered adapter type. Use when a
// runtime value arrives as a plain string (e.g. from an approval payload)
// before it can be passed where an AdapterType is required.
export function isAdapterType(value: string): value is AdapterType {
  return (ADAPTER_TYPES as readonly string[]).includes(value);
}

export interface OpenclawAdapterConfig {
  gatewayUrl: string;
  apiKey: string;
}

// Hermes adapter config mirrors `HermesAdapterConfig` from
// `@occa/adapter-hermes/src/types.ts`. Re-declared here (not imported)
// because `@occa/shared` must stay adapter-agnostic — only the field
// shapes that cross the HTTP boundary live here. Same gateway-url +
// bearer-token shape as OpenClaw since both adapters now use HTTP.
export interface HermesAdapterConfig {
  gatewayUrl: string;
  apiKey: string;
}

// claude-code runs either as a local subprocess (authed from the host env)
// or, for BYORT, against a remote Claude Gateway. When `gatewayUrl` is set
// the adapter talks HTTP to that gateway (with `apiKey` as bearer); absent,
// it spawns `claude -p` locally. The only always-present field is the model.
export interface ClaudeCodeAdapterConfig {
  model?: string;
  /** Remote Claude Gateway base URL. Absent = local subprocess mode. */
  gatewayUrl?: string;
  /** Bearer for the remote gateway. Required when `gatewayUrl` is set. */
  apiKey?: string;
}

// Model options offered in the claude-code runtime picker. The `value` is the
// alias passed to `claude --model` — aliases auto-upgrade to the latest
// version in each family and keep older stored configs (e.g. "sonnet") valid,
// so no migration is needed when Anthropic ships a new point release. The
// `label` surfaces the current version + a one-line tier hint so the picker
// mirrors Claude Code's own model menu instead of showing bare alias names.
export const CLAUDE_CODE_MODELS = [
  { value: "sonnet", label: "Sonnet 4.6 · efficient (default)" },
  { value: "opus", label: "Opus 4.8 · highest quality" },
  { value: "fable", label: "Fable 5 · most capable, priciest" },
  { value: "haiku", label: "Haiku 4.5 · fastest, cheapest" },
] as const;

// Union of all known adapter configs. Per `adapterType` discrimination
// lives in the server zod schema; client TS can pass any shape.
export type AdapterConfig =
  | OpenclawAdapterConfig
  | HermesAdapterConfig
  | ClaudeCodeAdapterConfig;

// ── POST /api/adapters/openclaw/probe ──
export interface ProbeRequest {
  gatewayUrl: string;
  apiKey: string;
}

export type ProbeErrorCode =
  | "unreachable"
  | "unauthorized"
  | "pairing_required"
  | "invalid_response";

export interface ProbeResponse {
  ok: boolean;
  latencyMs: number;
  error?: ProbeErrorCode | HermesProbeErrorCode;
  info?: {
    scopes?: string[];
    connId?: string;
    protocol?: number;
    version?: string;
    exitCode?: number | null;
    stderr?: string;
    message?: string;
  };
}

// ── POST /api/adapters/hermes/probe ──
export interface HermesProbeRequest {
  gatewayUrl: string;
  apiKey: string;
}

export type HermesProbeErrorCode =
  | "config_invalid"
  | "probe_timeout"
  | "probe_failed"
  | "unreachable"
  | "unauthorized"
  | "invalid_response";

// ── Deployment channels ──
// External chat surfaces (Telegram/Discord/etc) that route user↔CEO via
// the deployment's adapter. CEO-only — server rejects upserts for any
// deployment with role !== CEO_ROLE. Intersection of channels supported
// by both adapter-openclaw and adapter-hermes (so any CEO can opt in
// regardless of which runtime it runs on).
export const CHANNEL_TYPES = [
  "telegram",
  "discord",
  "whatsapp",
  "slack",
  "signal",
  "matrix",
  "mattermost",
  "line",
  "feishu",
  "qqbot",
  "bluebubbles",
  "googlechat",
  "msteams",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUS = [
  "off",
  "connecting",
  "connected",
  "error",
] as const;
export type ChannelStatus = (typeof CHANNEL_STATUS)[number];

// An interactive action attached to an outbound channel notification.
// Transports with native interactive UI (Telegram inline keyboard, Slack
// actions) render it as a tappable control and route the operator's tap
// back through the matching decision path; text-only transports degrade it
// to a "reply APPROVE/REJECT" instruction. Discriminated by `kind` so new
// action families land without widening every transport at once. The
// transport owns the on-the-wire callback encoding — producers only
// declare intent (semantic fields), never a channel-specific payload.
export type ChannelAction = {
  kind: "approval_decision";
  decision: ApprovalDecision;
  // The approval row this tap decides.
  approvalId: string;
  // Operator-facing button text, e.g. "Approve".
  label: string;
};

export interface ChannelDTO {
  channelType: ChannelType;
  enabled: boolean;
  chatEnabled: boolean;
  notifEnabled: boolean;
  status: ChannelStatus;
  statusMsg: string | null;
  lastSyncedAt: string | null;
  // Sanitized credentials — server returns `{ hasToken: true }` rather
  // than the raw token so the UI can render "configured" state without
  // exposing the secret.
  credentialsSummary: Record<string, boolean | string | null>;
  updatedAt: string;
}

// PUT /api/deployments/:id/channels/:type
export interface ChannelUpsertRequest {
  // Channel-specific credential payload. Server validates shape per
  // channelType via zod. Telegram example: `{ botToken: "..." }`.
  credentials: Record<string, unknown>;
  enabled?: boolean;
  chatEnabled?: boolean;
  notifEnabled?: boolean;
}

// ── POST /api/agents ──
// Atomic onboarding entry point. If the caller has no company yet, supply
// `companyName` and the server will create company + agent + provision the
// OpenClaw side as one operation. If provisioning fails, both rows are
// rolled back so the user never ends up with an orphan company.
//
// If the caller already has a company, `companyName` is ignored — agents
// always attach to the existing company.
//
// 400 `company_required` if no company and no `companyName`.
export interface CreateAgentRequest {
  name: string;
  role: AgentRole;
  // Free-text specialty ("specialist for X"). Persisted on the identity.
  persona?: string | null;
  adapterType: AdapterType;
  adapterConfig: AdapterConfig;
  companyName?: string;
  // Placement signal. Set = company-origin deploy (attach to this company
  // with an index, parent, and seat). Omitted = user-origin deploy (idle
  // agent, no company). Server authorizes ownership before attaching.
  companyId?: string | null;
  // Optional explicit parent. When omitted / null, the server falls back
  // to catalog-driven auto-resolve (canonical head per role-catalog →
  // CEO → null). Pass an active deployment id to override that default.
  parentAgentId?: string | null;
  // Optional flat per-task invoice amount in lamports, set at deploy time.
  // Omitted / null = no rate yet (operator sets it later from the Wallet
  // tab). Off-chain operational config.
  taskRateLamports?: number | null;
}

export interface CreateAgentResponse {
  agent: AgentDTO;
  // Present when this call also created the company (first-time onboarding).
  // Lets the client hydrate company state without a follow-up /api/me fetch.
  company?: CompanyDTO;
  // Number of existing specialists that were auto-reparented under this
  // new head. Non-zero only when role is a head AND specialists existed
  // under CEO whose canonical parent is the new head's role. Client uses
  // this to surface a "Reparented N specialists under Nova" toast.
  reparentedCount?: number;
}

// ── GET /api/agents ──
export interface ListAgentsResponse {
  agents: AgentDTO[];
}

// ── GET /api/agents/:id/files ──
export interface WorkspaceFileDTO {
  id: string;
  filename: string;
  content: string;
  source: string;
  templateOrigin: string | null;
  syncedAt: string | null;
  updatedAt: string;
}

export interface ListAgentFilesResponse {
  files: WorkspaceFileDTO[];
}

// ── PATCH /api/agents/:id/files/:filename ──
export interface UpdateAgentFileRequest {
  content: string;
}

export interface UpdateAgentFileResponse {
  file: WorkspaceFileDTO;
  // Present when the DB write succeeded but the gateway push did not.
  // The local edit is persisted with syncedAt=null; client can retry or
  // surface the warning. Absent on full success.
  syncWarning?: {
    code: string;
    detail?: string;
  };
}

// ── Agent skill syncs ─────────────────────────────────────────────────
// pending   = queued, worker hasn't picked it up yet
// installing = worker sent the prompt, waiting for agent reply
// installed  = agent confirmed with [[SKILL:INSTALLED]]
// failed     = agent replied [[SKILL:FAILED]] or prompt error
// outdated   = installed but skillRef differs from library's sourceRef (derived)
// skill_deleted = skill no longer in library (derived, not persisted)
export type AgentSkillSyncStatus =
  | "pending"
  | "installing"
  | "installed"
  | "failed"
  | "outdated"
  | "skill_deleted";

export type AgentSkillSyncAction = "install" | "uninstall" | "reinstall";

export interface AgentSkillSyncDTO {
  id: string;
  agentId: string;
  skillKey: string;
  status: AgentSkillSyncStatus;
  action: AgentSkillSyncAction;
  skillRef: string | null;
  skillUrl: string | null;
  lastError: string | null;
  installedAt: string | null;
  updatedAt: string;
}

export interface ListAgentSkillSyncsResponse {
  syncs: AgentSkillSyncDTO[];
}

// ── Tasks ──────────────────────────────────────────────────────────
// `blocked` is set by the BLOCK agent action — task is parked waiting
// on its blockedByTaskIds list. When all blockers reach `done`, the
// L2 cascade flips it back to `todo` and re-dispatches.
export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
  // Technical failure (gateway down, timeout, server restart, missing
  // tool). Distinct from `done` (no disbursement) and from archive (stays
  // visible). Surfaced in the board's "Needs attention" column alongside
  // `blocked` so the operator sees it and can retry or dismiss.
  "error",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Document kind — separates a shipped deliverable (the canonical published
// piece, carrying its real headline + topic tags) from intermediate process
// scratch (workflow stage outputs: draft, fact-check, SEO pass). The memory
// coverage signal counts deliverables only; process docs stay browsable but
// don't inflate "what have we already covered". Default is `deliverable`:
// a standalone task's reply IS the deliverable; only pipeline sub-stages and
// already-published tasks get reclassified at save time.
export const DOCUMENT_KINDS = ["deliverable", "process"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// Single-select shape of work (Notion-style "Task type"). Distinct from the
// free-form `tags` list — task type describes *what kind of work* it is, while
// tags are any label the user wants.
export const TASK_TYPES = [
  "feature",
  "bug",
  "research",
  "docs",
  "chore",
  "other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

// T-shirt sizing for rough effort estimation. Feeds budget/plan UI later.
export const EFFORT_LEVELS = ["xs", "s", "m", "l", "xl"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type ContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading_1"; text: string }
  | { type: "heading_2"; text: string }
  | { type: "heading_3"; text: string }
  | { type: "bullet"; text: string }
  | { type: "checklist"; text: string; checked: boolean }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "divider" }
  | {
      // Emitted by the worker when a trace succeeds. Not user-creatable via
      // the slash menu — full text lives on the trace itself
      // (traces.resultJson.text) and is fetched on demand when the card is
      // clicked.
      type: "agent_result";
      traceId: string;
      agentId: string;
      agentName: string;
      timestamp: string;
      preview: string;
    };

export interface TaskDTO {
  id: string;
  companyId: string;
  // Per-company monotonic number shown in UI (e.g. #12). Uuid `id` remains the
  // authoritative key; this is just the human-readable handle.
  taskNumber: number;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  title: string;
  blocks: ContentBlock[];
  status: TaskStatus;
  priority: TaskPriority;
  taskType: TaskType;
  effortLevel: EffortLevel;
  tags: string[];
  dueDate: string | null;
  linkedTraceId: string | null;
  // Published URL of the deliverable, anchored on-chain as the trace's
  // result_uri. Set by the agent (after posting via a tool) or manually.
  // Null = private work (anchored without a public link).
  resultUri: string | null;
  // Parent in the task graph (set when an agent created this task via an
  // approved DELEGATE — the parent task is the one the requesting agent
  // was working on at the time).
  parentTaskId: string | null;
  // Tasks this one is waiting on (BLOCK action target). When all of
  // these transition to `done`, L2 cascade re-wakes the assignee.
  blockedByTaskIds: string[];
  // Mutually exclusive with createdByAgentId.
  createdByUserId: string | null;
  // Set when the task was born from an approved agent DELEGATE.
  createdByAgentId: string | null;
  // Delegation contract — what "done" looks like, set on agent-created tasks.
  acceptanceCriteria: string | null;
  // Soft-archive — non-null timestamp means the task has been shelved
  // (not the same as `done`). Hidden from the default board; surfaced
  // only when the user toggles "Show archived". Reversible.
  archivedAt: string | null;
  archiveReason: string | null;
  // Set when status is `error` — the technical reason the run failed
  // (e.g. "timeout", "server_restart", gateway error code). Drives the
  // reason badge on the card. Cleared when a fresh run starts.
  errorCode: string | null;
  // Set when this task is a step inside a sequential workflow run. Lets
  // the detail view show that the task belongs to a pipeline and where in
  // the sequence it sits. Null for ad-hoc / parallel tasks.
  workflowRunId: string | null;
  workflowStepIndex: number | null;
  // The bound workflow's yaml id, resolved from the run. Only populated on
  // the single-task detail fetch (the board list skips the lookup). Null
  // when the task is not part of a workflow run.
  workflowYamlId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  title: string;
  blocks?: ContentBlock[];
  status?: TaskStatus;
  priority?: TaskPriority;
  taskType?: TaskType;
  effortLevel?: EffortLevel;
  tags?: string[];
  dueDate?: string | null;
  assignedAgentId?: string | null;
  resultUri?: string | null;
}

export type UpdateTaskRequest = Partial<CreateTaskRequest>;

export interface ListTasksResponse {
  tasks: TaskDTO[];
  /** Present only on paginated requests — whether a further page exists. */
  hasMore?: boolean;
}

/** Per-status board counts. `counts` covers active rows; `archived` is the total shelved. */
export interface TaskCountsResponse {
  counts: Partial<Record<TaskStatus, number>>;
  archived: number;
}

export interface TaskResponse {
  task: TaskDTO;
}

// ── Task event log (timeline) ────────────────────────────────────────
//
// Append-only mirror of the on-server `task_events` table. Per-task
// sequence is monotonic so the UI can render events in order without a
// secondary sort. Payload shape varies by `eventType` — consumers should
// narrow on `eventType` before reading payload fields. See
// `apps/server/src/features/tasks/domain/task-events.ts` for the full
// per-event payload contracts.
export type TaskEventTypeDTO =
  | "task_created"
  | "task_assigned"
  | "task_status_changed"
  | "agent_trace_started"
  | "agent_trace_finished"
  | "agent_action_emitted"
  | "comment_added"
  | "task_blocked"
  | "task_unblocked"
  | "task_archived"
  | "task_unarchived";

export type TaskEventActorTypeDTO = "user" | "agent" | "system";

export interface TaskEventDTO {
  id: string;
  taskId: string;
  sequence: number;
  eventType: TaskEventTypeDTO;
  actorType: TaskEventActorTypeDTO;
  actorId: string | null;
  payload: Record<string, unknown>;
  traceId: string | null;
  createdAt: string;
}

export interface ListTaskEventsResponse {
  events: TaskEventDTO[];
}

// Summed token/cost accounting across every trace a task ran (re-dispatches
// accumulate). `runs` counts the traces that carried usage. costCents is
// integer cents. Powers the per-task "Run cost" block in the task detail.
export interface TaskUsageSummary {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  costCents: number;
}

// ── Task comments — agent ↔ agent + user ↔ agent thread ─────────────
//
// Used by the ASK action and the @mention wake mechanism. Body is plain
// text with `@<agent-name>` tokens; the server resolves names → uuids
// and stores them in `mentions` + wakes those agents.
export interface TaskCommentDTO {
  id: string;
  taskId: string;
  // Mutually exclusive — exactly one of these is non-null.
  authorAgentId: string | null;
  authorUserId: string | null;
  // Resolved at server side — agent name shown in UI.
  authorAgentName: string | null;
  body: string;
  // Resolved agent UUIDs from `@name` tokens in `body`.
  mentions: string[];
  // Convenience for UI rendering — names matching `mentions[]`.
  mentionNames: string[];
  createdAt: string;
}

export interface CreateTaskCommentRequest {
  body: string;
}

export interface ListTaskCommentsResponse {
  comments: TaskCommentDTO[];
}

export interface TaskCommentResponse {
  comment: TaskCommentDTO;
}

// ── Skills — central catalog, HTTP-on-demand delivery ─────────────
export const SKILL_SOURCE_TYPES = ["github"] as const;
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];

export const SKILL_FILE_KINDS = [
  "markdown",
  "script",
  "reference",
  "asset",
] as const;
export type SkillFileKind = (typeof SKILL_FILE_KINDS)[number];

export interface SkillFileEntry {
  path: string;
  kind: SkillFileKind;
}

export interface SkillDTO {
  id: string;
  // null = platform built-in, shared across companies.
  companyId: string | null;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: SkillSourceType;
  sourceLocator: string;
  sourceRef: string;
  sourceOwner: string;
  sourceRepo: string;
  sourcePath: string;
  fileInventory: SkillFileEntry[];
  allowedRoles: AgentRole[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ImportSkillRequest {
  source: string;
  allowedRoles?: AgentRole[];
}

export interface UpdateSkillRequest {
  allowedRoles?: AgentRole[];
}

export interface ListSkillsResponse {
  skills: SkillDTO[];
}

export interface SkillResponse {
  skill: SkillDTO;
}

// ── Wake + Trace primitives ───────────────────────────────────────────
export type WakeSource =
  | "timer"
  | "assignment"
  | "on_demand"
  | "automation"
  | "chat"
  | "skill_sync";

export type TraceStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type LivenessState = "normal" | "plan_only" | "empty_response";

export type WakeActorType = "user" | "agent" | "system";

export interface WakeActor {
  type: WakeActorType;
  id: string | null;
}

export interface TraceUsage {
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  costCents: number;
}

// Snapshot of one skill the agent had loaded at the moment a trace was
// opened. Captured at trace-start (the agent's `desiredSkills` resolved
// to identity + version pin), NOT at actual invocation — that's a
// later refinement once adapters report per-skill usage.
//
// `id` is the local companySkills row UUID; will map to an on-chain
// PDA when SkillAccount lands in Phase 3. `key` is the canonical
// "owner/repo/slug" for cross-system reference. `sourceRef` is the git
// commit SHA the skill content was pinned to — the de-facto version.
export interface SkillUsageEntry {
  id: string;
  key: string;
  sourceRef: string;
}

export interface TraceDTO {
  id: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  conversationId: string | null;
  retryOfTraceId: string | null;
  invocationSource: WakeSource;
  triggerDetail: string | null;
  status: TraceStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorCode: string | null;
  livenessState: LivenessState | null;
  continuationAttempt: number;
  failureRetryAttempt: number;
  retryReason: string | null;
  scheduledAt: string | null;
  usage: TraceUsage | null;
  resultJson: Record<string, unknown> | null;
  sessionIdAfter: string | null;
  skillsUsed: SkillUsageEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface TraceEventDTO {
  id: number;
  traceId: string;
  seq: number;
  eventType: string;
  stream: string | null;
  level: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface WakeAgentRequest {
  reason?: string;
  taskId?: string;
}

export interface WakeAgentResponse {
  traceId: string;
  coalesced: boolean;
}

export interface CancelTraceRequest {
  reason?: string;
}

export interface ListTracesResponse {
  traces: TraceDTO[];
  nextCursor: string | null;
}

export interface TraceResponse {
  trace: TraceDTO;
}

export interface ListTraceEventsResponse {
  events: TraceEventDTO[];
  nextSeq: number;
}

export interface PostTraceHeartbeatEventRequest {
  seq: number;
  eventType: string;
  stream?: string | null;
  level?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

// ── Agent API keys ────────────────────────────────────────────────────
export interface AgentApiKeyDTO {
  id: string;
  agentId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateAgentTokenRequest {
  name: string;
}

export interface CreateAgentTokenResponse {
  key: AgentApiKeyDTO;
  rawKey: string; // shown once at creation
}

export interface ListAgentTokensResponse {
  keys: AgentApiKeyDTO[];
}

// ── Routines ──────────────────────────────────────────────────────────
export type RoutineTriggerKind = "cron" | "webhook" | "manual";

export interface RoutineTriggerDTO {
  id: string;
  routineId: string;
  kind: RoutineTriggerKind;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
}

export interface RoutineDTO {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  // When set, a fire starts this sequential workflow (by yaml id) instead
  // of waking the assignee for free-form work. Null = legacy behaviour.
  workflowYamlId: string | null;
  variables: Record<string, unknown> | null;
  lastTriggeredAt: string | null;
  lastEnqueuedAt: string | null;
  triggers: RoutineTriggerDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutineRequest {
  title: string;
  description?: string;
  assigneeAgentId: string;
  priority?: string;
  workflowYamlId?: string;
  triggers: Array<{
    kind: RoutineTriggerKind;
    label?: string;
    enabled?: boolean;
    cronExpression?: string;
    timezone?: string;
  }>;
}

export interface UpdateRoutineRequest {
  title?: string;
  description?: string;
  assigneeAgentId?: string;
  priority?: string;
  status?: string;
  workflowYamlId?: string;
}

export interface CreateTriggerRequest {
  kind: RoutineTriggerKind;
  label?: string;
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
}

export interface UpdateTriggerRequest {
  label?: string;
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
}

export interface ListRoutinesResponse {
  routines: RoutineDTO[];
}

export interface RoutineResponse {
  routine: RoutineDTO;
}

// ── Agent activity — grouped trace feed ───────────────────────────────
// Activity groups surface all agent interactions in one unified feed.
// Grouping key: conversationId (chat), taskId (task run), skillKey via
// triggerDetail (skill_sync), or traceId (standalone/scheduled runs).
export type ActivityGroupKind = "chat" | "task" | "skill_sync" | "trace";

export interface ActivityTraceRef {
  id: string;
  status: TraceStatus;
  invocationSource: WakeSource;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface ActivityGroup {
  // Stable group identifier (conversationId | taskId | skillKey | traceId)
  groupKey: string;
  kind: ActivityGroupKind;
  // Human-readable label: task title, skill name, conversation preview, etc.
  label: string;
  // Latest trace in the group
  latestTrace: ActivityTraceRef;
  // Total number of traces in this group
  traceCount: number;
  // Timestamp of the most recent activity
  lastActivityAt: string;
}

export interface ListActivityResponse {
  groups: ActivityGroup[];
  nextCursor: string | null;
}

// ── Approvals ────────────────────────────────────────────────────────
// Free-form action discriminator. Known actions are listed in
// APPROVAL_ACTION_TYPES; the schema accepts any string so future action
// kinds can land without a migration.
// "propose_deployment" rows are created by the CEO PROPOSE_DEPLOYMENT
// marker and surfaced in the Approvals window, where the operator opens
// the "Deploy this" handoff (the pre-filled deploy modal) rather than a
// plain approve — the agent is provisioned only by that operator-signed
// deploy, never by approve alone.
// "edit_company_profile" rows are created by the CEO PROPOSE_PROFILE_EDIT
// marker; approve applies the proposed profile patch via the with-approval
// engine. The payout wallet is never part of the payload (operator-only).
export const APPROVAL_ACTION_TYPES = [
  "delegate",
  "propose_deployment",
  "edit_company_profile",
  "edit_knowledge",
  "edit_routine",
  "edit_skill_library",
  "edit_tool",
  "create_workflow",
  "edit_workflow",
  "create_routine",
] as const;
export type ApprovalActionType =
  | (typeof APPROVAL_ACTION_TYPES)[number]
  | (string & {});

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// Payload schema for actionType === "delegate" — assign work to an
// existing agent in the requester's subtree. On approve, server creates a
// child task and dispatches it.
export interface DelegatePayload {
  targetAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  parentTaskId?: string | null;
}

// Payload schema for actionType === "propose_deployment" — the CEO
// proposes adding an agent to the company from chat. ZERO-AUTHORITY:
// nothing is created until the operator opens the proposal in the OS,
// supplies the gateway endpoint + token, and signs. The payload carries
// ONLY operator-curated catalog selections (role, runtime, skill keys)
// — never an endpoint, a credential, or a signature. `suggestedName` is
// a display label the CEO proposes; the operator edits it in the deploy
// modal.
export interface ProposeDeploymentPayload {
  role: AgentRole;
  runtime: AdapterType;
  desiredSkills: string[];
  suggestedName: string | null;
}

// Body for the agent-self approval submission endpoint.
export interface AgentApprovalCreateRequest {
  actionType: ApprovalActionType;
  payload: DelegatePayload | Record<string, unknown>;
}

export interface AgentApprovalCreateResponse {
  approvalId: string;
}

export interface ApprovalDTO {
  id: string;
  companyId: string;
  requestedByAgentId: string | null;
  actionType: ApprovalActionType;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  rejectionReason: string | null;
}

export interface DecideApprovalRequest {
  decision: "approve" | "reject";
  rejectionReason?: string;
}

export interface DecideApprovalResponse {
  approval: ApprovalDTO;
}

// Body-less POST /api/approvals/:id/dismiss — operator clears a pending row
// from the queue without an approve/reject decision (sets the "cancelled"
// terminal status). No side effects, no reason. Distinct from reject, which
// is an explicit denial carrying a reason.
export interface DismissApprovalResponse {
  approval: ApprovalDTO;
}

export interface ListApprovalsResponse {
  approvals: ApprovalDTO[];
}

// ── Notifications ────────────────────────────────────────────────────
// Inbox event stream for the operator. Every approval emits one
// notification; non-approval events (treasury readiness, anchor failure,
// etc.) emit notifications too. `kind` discriminates payload shape.
//
// Known kinds listed here; schema accepts any string so new kinds land
// without a migration. Reserve `approval_*` prefix for approval-derived
// notifications so consumers can route generically.
export const NOTIFICATION_KINDS = [
  "approval_pending",
  // Dispatch halted before an agent could start a task. Carries
  // payload.reason ("budget_exhausted" | "agent_unavailable") and a
  // "tasks:<taskId>" link. See features/tasks/services/dispatch-halt-notify.
  "task_dispatch_halted",
] as const;
export type NotificationKind =
  | (typeof NOTIFICATION_KINDS)[number]
  | (string & {});

export interface NotificationDTO {
  id: string;
  companyId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  /** In-app deep link target. Format "<window>:<id?>". */
  link: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

export interface ListNotificationsResponse {
  notifications: NotificationDTO[];
  unreadCount: number;
}

export interface NotificationActionResponse {
  notification: NotificationDTO;
}

// ── Routine triggers + status ────────────────────────────────────────
export const ROUTINE_TRIGGER_KINDS = ["cron", "webhook", "manual"] as const;
export type RoutineTriggerKindEnum = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatusEnum = (typeof ROUTINE_STATUSES)[number];

// ── Kickoff presets ──────────────────────────────────────────────────
export const KICKOFF_PRESETS = ["bootstrap", "standard", "full"] as const;
export type KickoffPreset = (typeof KICKOFF_PRESETS)[number];

// ── Skill sync actions ───────────────────────────────────────────────
export const SKILL_SYNC_ACTIONS = [
  "install",
  "uninstall",
  "reinstall",
] as const;
export type SkillSyncAction = (typeof SKILL_SYNC_ACTIONS)[number];


// ── Workflows ────────────────────────────────────────────────────────
export interface WorkflowDTO {
  id: string;
  companyId: string;
  yamlId: string;
  name: string;
  description: string | null;
  yamlText: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListWorkflowsResponse {
  workflows: WorkflowDTO[];
}

// ── Tools primitive (catalog + per-company instance management) ────────
// See tools-primitive-design.md at workspace root for the full design.

// A field declaration derived from a handler's Zod credential schema.
// The UI uses this to render the install form (one input per field) so
// the OCCA team doesn't write a form per integration.
export interface ToolCredentialField {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  // True when this field stores a secret (password/token). UI masks it.
  secret: boolean;
  description?: string;
  // True (string fields only) when the install UI should render a
  // resizeable multi-line textarea instead of a single-line input — for
  // long values like a locked house-style prompt.
  multiline?: boolean;
}

export interface ToolActionSpec {
  name: string;
  description: string;
}

export interface ToolCatalogEntry {
  type: string;
  displayName: string;
  description: string;
  credentialFields: ToolCredentialField[];
  metadataFields: ToolCredentialField[];
  actions: ToolActionSpec[];
  hasTestConnection: boolean;
  hasDynamicActions: boolean;
}

export interface ToolCatalogResponse {
  tools: ToolCatalogEntry[];
}

// A serialized company-installed tool. NEVER includes the plaintext
// credentials — those decrypt only at invocation time, in memory.
export interface CompanyToolDTO {
  id: string;
  companyId: string;
  type: string;
  displayName: string; // resolved from the catalog at serialize time
  label: string;
  metadata: Record<string, unknown>;
  status: "active" | "paused" | "failed";
  // Role gate. Empty array = visible to all roles. Same semantics as
  // company_skills.allowed_roles.
  allowedRoles: AgentRole[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListCompanyToolsResponse {
  tools: CompanyToolDTO[];
}

export interface InstallCompanyToolRequest {
  type: string;
  label: string;
  // Plaintext credentials matching the handler's credentialsSchema.
  // Validated server-side and encrypted before persistence; never logged.
  credentials: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  // Role gate. Omit or empty array = visible to all roles. Otherwise
  // only listed roles can have the tool surfaced via discovery.
  allowedRoles?: AgentRole[];
  // When true, run the handler's testConnection (if available) right
  // after install and surface the result in the response.
  testAfterInstall?: boolean;
}

export interface UpdateCompanyToolRequest {
  label?: string;
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: "active" | "paused";
  allowedRoles?: AgentRole[];
}

export interface CompanyToolResponse {
  tool: CompanyToolDTO;
  testConnection?: ToolTestConnectionResult;
}

export type ToolTestConnectionResult =
  | { ok: true; detail?: string }
  | { ok: false; errorCode: string; errorMessage: string };

export interface TestCompanyToolResponse {
  result: ToolTestConnectionResult;
}

export interface ToolCallLogDTO {
  id: string;
  toolId: string;
  deploymentId: string | null;
  action: string;
  status: "success" | "failed" | "rate_limited";
  resultSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface ListToolCallLogsResponse {
  logs: ToolCallLogDTO[];
}

// Agent-facing tool discovery (GET /api/me/agent/tools).
// Same shape as the operator-side CompanyToolDTO but trimmed to what
// the agent needs to decide which tool to call. Action list pulled in
// from the catalog at serialize time.
export interface AgentToolDTO {
  id: string;
  type: string;
  label: string;
  displayName: string;
  status: "active" | "paused" | "failed";
  actions: ToolActionSpec[];
}

export interface ListAgentToolsResponse {
  tools: AgentToolDTO[];
}

// Agent-facing invocation. Body is passed straight through after the
// generic-shape check; the handler's inputSchema does the strong
// validation server-side.
export interface InvokeToolRequest {
  input: Record<string, unknown>;
}

export interface InvokeToolResponse {
  ok: true;
  output: unknown;
}

export interface InvokeToolErrorResponse {
  ok: false;
  errorCode: string;
  errorMessage: string;
  rateLimited?: boolean;
}

// ── Company webhooks ──────────────────────────────────────────────────
//
// A webhook is a per-company outbound connection: a named endpoint + a
// signing secret. It carries last-delivery diagnostics so the operator can
// see health at a glance. The secret is write-only — the API never returns
// it; `hasSecret` only signals whether one is configured.
export interface WebhookDTO {
  id: string;
  companyId: string;
  name: string;
  targetUrl: string;
  event: string;
  enabled: boolean;
  hasSecret: boolean;
  lastDeliveredAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  /** Raw response body from the last delivery, capped. Opaque to OCCA. */
  lastResponse: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListWebhooksResponse {
  webhooks: WebhookDTO[];
}

export interface WebhookResponse {
  webhook: WebhookDTO;
}

// Result of a manual test delivery. `status` is the HTTP status string, or
// "error" when the request itself failed (DNS, timeout, refused).
export interface WebhookTestResponse {
  ok: boolean;
  status: string;
  /** Raw response body the receiver returned, capped. Null when empty. */
  response: string | null;
}

export interface CreateWebhookRequest {
  name: string;
  targetUrl: string;
  secret: string;
  enabled?: boolean;
}

// Partial update. `secret` present = rotate it; absent = leave unchanged.
export type UpdateWebhookRequest = Partial<CreateWebhookRequest>;
