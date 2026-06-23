// ContextSpec — canonical shape returned by `loadContext()`. Every prompt
// surface (chat, task, heartbeat) consumes this single type and renders
// surface-specific text. Decided 2026-05-10 as the memory pipeline
// (replaces ad-hoc per-surface builders).
//
// The spec carries one field per memory TYPE, each loaded by a store in
// `stores/`. Load CADENCE (always-on / session / on-demand) is decided
// by the assembler in `load-context.ts`, not encoded here — type and
// cadence are separate axes.
//   • agent / company — identity. The agent's stable sense of self.
//   • org             — company structure: team, gaps, subordinates.
//   • knowledge       — semantic memory: distilled facts (Company Brain).
//                       OPTIONAL; renderers gracefully omit when undefined.
//   • history         — episodic memory: what the company has done.
//                       OPTIONAL; renderers gracefully omit when undefined.
//
// Gateway filesystem (workspace markdown seeded at provision) is NOT
// carried here — renderers emit pointers (e.g. "read ./SOUL.md") so the
// agent fetches via its tools.
//
// Surface payload — caller-supplied per-call data the renderer needs
// (the actual user message, the task row, etc.) but that doesn't fit
// any of the agent-state memory types.

import type { RoleTier } from "@occa/shared/role-catalog";

export interface ContextAgent {
  id: string; // deployment id
  name: string;
  role: string; // slug
  roleLabel: string; // display
  tier: RoleTier | "unknown";
}

export interface ContextCompanyProfile {
  // Mirrors `company_profile` columns we want the agent to see at runtime.
  // All optional — onboarding may have left fields blank.
  tagline: string | null;
  niche: string | null;
  brandVoice: string | null;
  contentPillars: string[];
  forbiddenWords: string[];
  coverageScope: string | null;
  coverageExcluded: string | null;
}

export interface ContextCompany {
  id: string;
  name: string;
  profile: ContextCompanyProfile;
  // Research depth target for task prompts — ~this many searches + fetches
  // before the agent stops gathering and writes. Operator-tunable; default 6.
  researchBudget: number;
}

export interface ContextTeammate {
  id: string;
  name: string;
  role: string;
  tier: RoleTier | "unknown";
}

export interface ContextOrg {
  // Every active deployment in the company excluding the agent itself.
  // Used by chat surface to format "your team" and let CEO route by name.
  team: ContextTeammate[];
  // Roles in the default org chart that aren't deployed yet. Used by
  // chat surface to surface capability gaps to the owner.
  gaps: { role: string; tier: RoleTier | "unknown" }[];
  // Just the subset that reports to THIS agent (descendants in the
  // hierarchy). Used by task surface for DELEGATE hints. Differs from
  // `team` for non-CEO agents — a Head sees only their specialists,
  // not the rest of the company.
  subordinatesForSelf: ContextTeammate[];
}

// Semantic memory — optional. Populated when the company_brain table has
// rows. Filesystem-pattern: each entry is a "file" with a path + body.
// Renderers either embed full content (MVP) or emit a directory listing
// + leave the agent to fetch on-demand via memory tool (Phase 2 once the
// adapter contract exposes the tool API). Schema mirrors Anthropic's
// Memory Tool design — production-validated by Netflix/Rakuten.
//
// Visibility filtering happens server-side at loadContext, so anything
// reaching the renderer is already authorized for the calling agent.
export interface ContextBrainFile {
  path: string;
  content: string;
  sizeBytes: number;
}
export interface ContextKnowledge {
  brain: ContextBrainFile[];
}

export interface ContextHistory {
  recentCompletedTasks?: {
    taskNumber: number;
    title: string;
    summary: string;
  }[];
  relevantDocuments?: { id: string; title: string; snippet: string }[];
  // Coverage signal (task surface) — what the company has recently SHIPPED,
  // so an agent producing recurring work doesn't redundantly re-cover it.
  // Deliverables only (kind='deliverable'); process scratch is excluded.
  // High-resolution, count-bounded layer.
  recentlyProduced?: { title: string; tags: string[]; producedAt: string }[];
  // Per-tag deliverable counts over a recent window — surfaces saturated vs
  // sparsely-covered areas so the agent can favor gaps. Counts only, no
  // bodies, so it stays cheap across a long memory window.
  tagDistribution?: { tag: string; count: number }[];
}

// Assigned-skill view at run time. Full markdown is inlined so the
// renderer can drop it into the prompt without a separate fetch — agents
// previously skipped the GET-skills round-trip and hallucinated "no tool
// available" refusals (2026-05-20 X-posting regress). Loaded by
// `stores/skills.ts`; rendered as a fenced section by the task and chat
// renderers.
export interface ContextSkill {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
}

// CEO Runs OS surface — installable skill catalog + per-deployment
// installed snapshot. Populated only when the calling agent is CEO tier;
// renderers gate on `spec.ceoOps !== undefined`. Keeps non-CEO prompts
// free of operator-mutation noise.
export interface ContextInstallableSkill {
  key: string;
  name: string;
  description: string | null;
  // Empty array = unrestricted (any role may install). Non-empty =
  // whitelist of agent roles the skill is bindable to.
  allowedRoles: string[];
}
export interface ContextInstallableTool {
  // UUID — what BIND_TOOL.toolId references.
  id: string;
  type: string;
  label: string;
  // active | paused | failed. Renderer can hint at non-active status
  // so CEO doesn't bind to a known-broken tool.
  status: string;
  allowedRoles: string[];
}
// Per-channel runtime state visible to CEO. Credentials excluded —
// CEO must never see token material. Status mirrors the adapter-side
// state so the catalog can hint "this one is in error".
export interface ContextChannelState {
  channelType: string;
  enabled: boolean;
  chatEnabled: boolean;
  notifEnabled: boolean;
  status: string; // off | connecting | connected | error
}
// Workflow state visible to CEO. yamlText is intentionally omitted —
// CEO doesn't need to see the source to flip the runtime switch, and
// inlining a 500-line yaml inflates the prompt for no behavior gain.
export interface ContextWorkflowState {
  yamlId: string;
  name: string;
  description: string | null;
  enabled: boolean;
}

// Routine state — CEO addresses by UUID since routines have no slug.
// triggerSummary aggregates enabled triggers ("cron: 0 9 * * * (UTC)",
// "manual only") so CEO can describe cadence without us shipping every
// trigger row.
export interface ContextRoutineState {
  id: string;
  title: string;
  description: string | null;
  status: string; // "active" | "paused" | terminal states
  assigneeDeploymentId: string | null;
  triggerSummary: string;
}
// Roles the CEO may propose for a new deployment via PROPOSE_DEPLOYMENT.
// Sourced from the static role catalog minus the ceo tier (one CEO per
// company). This is the whitelist the CEO picks from — it cannot invent
// a role the platform doesn't define.
export interface ContextProposableRole {
  key: string;
  label: string;
  tier: string;
  description: string | null;
  // One-per-company role (c-suite or a head). When already filled it
  // must not be proposed again — the renderer marks it taken and the
  // handler rejects a duplicate.
  singleton: boolean;
}
// Runtimes a new deployment can run on — the registered adapter types.
// The CEO proposes one; the operator supplies that runtime's gateway
// endpoint + token in the deploy modal (never via chat).
export interface ContextProposableRuntime {
  type: string;
}
// Active board snapshot — open tasks the CEO can move (SET_TASK_STATUS)
// or remove (PROPOSE_TASK_DELETE). Carries the UUID because both markers
// address a task by id; without this listing the CEO has no way to learn
// a task's id from chat. Excludes done + archived (done shows under
// RECENT WORK and can't be reopened from chat anyway).
export interface ContextBoardTask {
  // UUID — what SET_TASK_STATUS.taskId / PROPOSE_TASK_DELETE.taskId reference.
  id: string;
  // Human-facing task number ("Task #42") for receipt + prose.
  number: number;
  title: string;
  status: string; // todo | in_progress | review | blocked
  assigneeName: string | null;
}
export interface ContextCeoOps {
  installableSkills: ContextInstallableSkill[];
  installableTools: ContextInstallableTool[];
  // deploymentId → desiredSkills[]. Empty arrays included so a
  // deployment without any installed skill still appears (lets CEO see
  // who is "blank slate" at a glance).
  installedByDeployment: Record<string, string[]>;
  // deploymentId → enabledTools[] (UUIDs into companyTools).
  boundToolsByDeployment: Record<string, string[]>;
  // Channels are CEO-only by schema design — single list, not a per-
  // deployment map.
  channels: ContextChannelState[];
  // All workflows for this company. CEO can toggle any of them.
  workflows: ContextWorkflowState[];
  routines: ContextRoutineState[];
  // Open tasks on the board (todo/in_progress/review/blocked, non-archived).
  activeTasks: ContextBoardTask[];
  // Whitelists the CEO proposes a new deployment from. The proposal is a
  // zero-authority pending row; the operator deploys it from the OS.
  proposableRoles: ContextProposableRole[];
  proposableRuntimes: ContextProposableRuntime[];
}

// Per-run server callback credentials. Minted fresh in the dispatcher
// before every wake and injected here so the renderer can emit the
// canonical `OCCA runtime:` preamble (apiUrl + bearer apiKey + agentId +
// traceId). Without these the agent has no way to call back into OCCA
// (skill discovery, tool invocation, RequestInfo / EmitFollowUp).
export interface ContextRuntimeEnv {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  traceId: string;
}

// Surface payload — the per-call non-agent data the renderer needs.
export type SurfacePayload =
  | {
      kind: "chat";
      // True only on the first turn of a session. First turn gets full
      // preamble; subsequent turns get a lighter team-refresh prompt.
      isFirstTurn: boolean;
      userMessage: string;
    }
  | {
      // Phase C: directive surface between two agents. The callee is the
      // ContextSpec.agent (recipient); the caller is one tier up and
      // sent the directive. Renderer reuses the chat-mode framing
      // (subordinates, HEAD-FIRST rule, DELEGATE/CREATE_TASK markers)
      // but swaps "owner" with the caller and frames the directive as
      // the inbound message.
      kind: "agent_dm";
      isFirstTurn: boolean;
      directive: string;
      callerName: string;
      callerRole: string;
    }
  | {
      kind: "task";
      taskId: string;
      taskNumber: number;
      title: string;
      priority: string;
      taskType: string;
      effortLevel: string;
      // Tags from the task row — used by loadContext to fetch related
      // prior documents (Tier 3b retrieval).
      tags: string[];
      bodyMarkdown: string;
      acceptanceCriteria: string | null;
      traceId: string;
      gatewayUrl: string | null;
      // True when this task has no parent. Combined with `isCeoAssignee`
      // below to decide whether the REPORT marker instructions are
      // included in the prompt — REPORT is CEO-only (handler enforces
      // `non_ceo_cannot_report`), and showing it to a specialist whose
      // root task originates from a chat-mode DELEGATE causes them to
      // emit it; the marker then gets stripped from the saved reply
      // and the content is lost. Only show REPORT when both `isRoot`
      // and `isCeoAssignee` are true (CEO self-execute path).
      isRoot: boolean;
      // True iff the task's assignee role is CEO tier. Gates the
      // REPORT block in the prompt.
      isCeoAssignee: boolean;
      completedChildren: {
        taskNumber: number;
        title: string;
        agentName: string | null;
        resultPreview: string | null;
      }[];
      // Task comments, oldest→newest (recent slice). Carries reviewer
      // and system feedback — e.g. a verification-gate bounce — the
      // agent must read and act on before re-attempting the task.
      comments: { from: "system" | "teammate"; body: string }[];
    };

// Workspace markdown the agent's identity lives in (SOUL.md, AGENTS.md,
// IDENTITY.md, HEARTBEAT.md, etc) — loaded with full content so the
// renderer can inline it. For adapters that mount a per-agent filesystem
// (OpenClaw), agents can ALSO read these via read_file from their CWD;
// for adapters that don't (Hermes), the prompt is the only place the
// content surfaces.
export interface ContextWorkspaceFile {
  filename: string;
  content: string;
}

export interface ContextSpec {
  agent: ContextAgent;
  company: ContextCompany;
  org: ContextOrg;
  // Optional memory — undefined until company_brain / documents have rows.
  knowledge?: ContextKnowledge;
  history?: ContextHistory;
  // Skills assigned to the calling deployment, loaded with full markdown
  // so renderers can inline them. Empty array when none assigned.
  skills: ContextSkill[];
  // Persona / operating markdown for this deployment. Empty array when
  // no files have been seeded yet.
  workspaceFiles: ContextWorkspaceFile[];
  // Optional. Present when the caller is a task/wake dispatcher minting
  // a per-trace ephemeral key. Chat-mode loaders that don't have a
  // trace context (e.g. CEO chat preview) leave this undefined and the
  // renderer falls back to "see your wake preamble" pointer text.
  runtimeEnv?: ContextRuntimeEnv;
  // CEO Runs OS context (catalog + installed-map). Present only when
  // the calling deployment is CEO tier.
  ceoOps?: ContextCeoOps;
  surface: SurfacePayload;
}
