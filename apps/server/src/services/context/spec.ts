// ContextSpec — canonical shape returned by `loadContext()`. Every prompt
// surface (chat, task, heartbeat) consumes this single type and renders
// surface-specific text. Decided 2026-05-10 as part of the Tiered Hybrid
// Context Pipeline (replaces ad-hoc per-surface builders).
//
// 4 tiers, each with a clear access pattern:
//   • Tier 1 (always-on, every turn) — identity + company profile. Cheap,
//     load on every prompt build.
//   • Tier 2 (session-scoped) — org chart (active team, capability gaps,
//     subordinates for self). Stable within a session, refreshed on
//     deploy/retire. Heavier than Tier 1 but bounded.
//   • Tier 3 (on-demand, RAG-ready) — knowledge base + document history.
//     OPTIONAL in the spec; renderers gracefully omit when undefined.
//     Populated by future tables (`company_brain`, `documents`).
//   • Tier 4 (gateway filesystem) — workspace markdown files seeded at
//     provision. NOT carried in the spec; renderers may emit pointers
//     (e.g. "read ./SOUL.md") so the agent fetches via its tools.
//
// Surface payload — caller-supplied per-call data the renderer needs
// (the actual user message, the task row, etc.) but that doesn't fit
// any of the agent-state tiers.

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

// Tier 3 — optional. Populated when the company_brain table has rows.
// Filesystem-pattern: each entry is a "file" with a path + markdown body.
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
    };

export interface ContextSpec {
  agent: ContextAgent;
  company: ContextCompany;
  org: ContextOrg;
  // Tier 3 — undefined until company_brain / documents tables ship.
  knowledge?: ContextKnowledge;
  history?: ContextHistory;
  surface: SurfacePayload;
}
