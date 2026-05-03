// OCCA changelog — edit this file to publish new entries.
// Date format: ISO 8601 (YYYY-MM-DD). Entries are rendered newest-first;
// keep this array sorted by date descending.

export type ChangelogTag = "feature" | "fix" | "improvement" | "breaking";

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  items: Array<{
    tag: ChangelogTag;
    text: string;
  }>;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.7.1",
    date: "2026-04-23",
    title: "UI component system",
    items: [
      {
        tag: "feature",
        text: "Reusable component library: Button, Badge, Input, Select, Alert, Card, SearchInput, Dropdown, Autocomplete, LoadingState, EmptyState — all tokens-based.",
      },
      {
        tag: "improvement",
        text: "Dock, AppWindow, and Modal now share a single tokens.ts surface system — consistent background, blur, and border across all chrome.",
      },
      {
        tag: "improvement",
        text: "HireAgentModal migrated to the new Modal component with Tahoe-glass vibrancy and portal rendering outside the window DOM tree.",
      },
    ],
  },
  {
    version: "0.7.0",
    date: "2026-04-22",
    title: "Agent identity bundle",
    items: [
      {
        tag: "feature",
        text: "Agents ship with a role-based personality bundle (AGENTS.md) materialized per-agent on creation — stops workspaces from hijacking agent identity via their own CLAUDE.md.",
      },
      {
        tag: "feature",
        text: "Wake messages prepend an authoritative identity block that overrides workspace-level persona files. An agent named Travis stays Travis.",
      },
      {
        tag: "improvement",
        text: "Pre-0.7.0 agents lazy-materialize their bundle on first OS load; no manual backfill needed.",
      },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-04-21",
    title: "Agent hiring",
    items: [
      {
        tag: "feature",
        text: "Agents with can_create_agents can request new teammates via POST /api/me/agent/hires — user approves via the approvals flow.",
      },
      {
        tag: "feature",
        text: "Org chart edge: agents.reports_to_agent_id tracks manager relationships.",
      },
      {
        tag: "feature",
        text: "Approvals infrastructure (minimal, extensible to sign_tx / spend later).",
      },
    ],
  },
  {
    version: "0.5.2",
    date: "2026-04-20",
    title: "Skill detail preview",
    items: [
      {
        tag: "improvement",
        text: "Skill list in agent detail shows a 2-line description preview.",
      },
      {
        tag: "improvement",
        text: "Click any skill row to open a read-only detail modal (name, description, roles, source, files).",
      },
    ],
  },
  {
    version: "0.5.1",
    date: "2026-04-19",
    title: "Role-filtered skill list",
    items: [
      {
        tag: "improvement",
        text: "Agent detail skills tab now filters by agent role at the API layer.",
      },
      {
        tag: "fix",
        text: "Unknown-skill-key error when toggling built-in skills (validation missed company_id IS NULL).",
      },
      {
        tag: "fix",
        text: "Once-only skill auto-assign via skills_initialized_at — server restart no longer re-enables user-disabled skills.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-04-18",
    title: "Built-in skill library",
    items: [
      {
        tag: "feature",
        text: "22 c-level-advisor skills seeded once at boot as platform built-ins (shared across companies).",
      },
      {
        tag: "feature",
        text: "New agents auto-assigned role-matching platform + company skills at onboarding.",
      },
      {
        tag: "feature",
        text: "GITHUB_TOKEN env var for private-skill fetches (documented in .env.example).",
      },
    ],
  },
  {
    version: "0.4.3",
    date: "2026-04-17",
    title: "Skill library window",
    items: [
      {
        tag: "feature",
        text: "Skills dock item opens a library of available platform + company skills.",
      },
      {
        tag: "improvement",
        text: "Agent detail gained a Skills tab with per-agent toggles that respect allowedRoles.",
      },
      {
        tag: "fix",
        text: "Company skill imports no longer silently overwrite platform defaults with the same key.",
      },
    ],
  },
  {
    version: "0.4.2",
    date: "2026-04-15",
    title: "Changelog + OS shell polish",
    items: [
      {
        tag: "feature",
        text: "Added a Changelogs dock item so operators can see what shipped without leaving the OS.",
      },
      {
        tag: "improvement",
        text: "Dock badges shrunk and aligned so they no longer clip window titles on narrow viewports.",
      },
      {
        tag: "improvement",
        text: "AppWindow now remembers its last position within a session to reduce re-dragging.",
      },
    ],
  },
  {
    version: "0.4.1",
    date: "2026-04-13",
    title: "Routines",
    items: [
      {
        tag: "feature",
        text: "Routines window: per-agent scheduled wake-ups with cron-style intervals.",
      },
      {
        tag: "feature",
        text: "Server-side scheduler fires wakeups into the agent inbox at the configured cadence.",
      },
      {
        tag: "improvement",
        text: "Routine edits no longer require a page reload — list refreshes in place after save.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-04-11",
    title: "Notifications & retry",
    items: [
      {
        tag: "feature",
        text: "Notifications window aggregates task events, hire decisions, and connection health alerts.",
      },
      {
        tag: "feature",
        text: "Per-user notification_dismissals — dismissed items stay hidden across sessions.",
      },
      {
        tag: "feature",
        text: "failure_retry_attempt counter on tasks with exponential backoff up to 3 tries before surfacing to the operator.",
      },
      {
        tag: "improvement",
        text: "Unread badge on dock Notifications icon reflects undismissed count in real time.",
      },
    ],
  },
  {
    version: "0.3.4",
    date: "2026-04-09",
    title: "Connection health",
    items: [
      {
        tag: "feature",
        text: "Agents report connection_state (connected / degraded / offline) on every heartbeat.",
      },
      {
        tag: "improvement",
        text: "Agent row shows a live status dot in the Agents window.",
      },
      {
        tag: "fix",
        text: "Stale runtime state no longer persists after an adapter crash — state is re-probed on next wake.",
      },
    ],
  },
  {
    version: "0.3.3",
    date: "2026-04-08",
    title: "Task metadata",
    items: [
      {
        tag: "feature",
        text: "task_type classifies work as strategic / tactical / administrative for better filtering.",
      },
      {
        tag: "feature",
        text: "effort_level (xs / s / m / l / xl) estimates roughly how much agent time a task will consume.",
      },
      {
        tag: "improvement",
        text: "Task Manager filter bar added with type + effort + status chips.",
      },
    ],
  },
  {
    version: "0.3.2",
    date: "2026-04-07",
    title: "Per-company task numbering",
    items: [
      {
        tag: "feature",
        text: "task_number: monotonically increasing per-company integer rendered as #42 in UI (replaces UUID prefix).",
      },
      {
        tag: "improvement",
        text: "Task titles in notifications now reference #N instead of a truncated uuid.",
      },
    ],
  },
  {
    version: "0.3.1",
    date: "2026-04-06",
    title: "Agent API keys",
    items: [
      {
        tag: "feature",
        text: "agent_api_keys table — per-agent scoped tokens used by adapters to call /api/me/agent/*.",
      },
      {
        tag: "feature",
        text: "Key rotation endpoint issues a new token and revokes the prior one atomically.",
      },
      {
        tag: "improvement",
        text: "Agent onboarding wizard surfaces the freshly minted API key with a one-shot copy UI.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-04-05",
    title: "Agent runtime state",
    items: [
      {
        tag: "feature",
        text: "agent_runtime_state row per agent tracks current task, wake queue, and last heartbeat.",
      },
      {
        tag: "feature",
        text: "Server-side wake loop dispatches pending wakeups to agents when they reconnect.",
      },
      {
        tag: "improvement",
        text: "Agent adapters can now resume an in-flight task after a disconnect without losing context.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-04-04",
    title: "Task Manager",
    items: [
      {
        tag: "feature",
        text: "Tasks dock item opens a per-company task board with assign / reassign / close flows.",
      },
      {
        tag: "feature",
        text: "Tasks can be addressed to a specific agent or left unassigned (agents self-pick).",
      },
      {
        tag: "feature",
        text: "Task comments capture agent-user dialogue with timestamped append-only history.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-04-01",
    title: "Initial launch",
    items: [
      {
        tag: "feature",
        text: "Sign-in with Solana wallet: server issues nonce, client signs, server returns JWT.",
      },
      {
        tag: "feature",
        text: "Company onboarding wizard: create company, hire first agent, connect OpenClaw adapter.",
      },
      {
        tag: "feature",
        text: "Agents window: roster, detail view, chat, wake, traces, files, and skills.",
      },
      {
        tag: "feature",
        text: "pnpm monorepo: apps/web (Next.js 16 + React 19), apps/server (Express + Drizzle + pg).",
      },
    ],
  },
];
