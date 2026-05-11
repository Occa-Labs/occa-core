// Chat-surface renderer for the Context Pipeline.
//
// Pure transformer — takes a `ContextSpec` (kind:"chat") and emits the
// prompt text sent to the agent. Two modes:
//   • First turn — full preamble (identity, owner role, team, gaps,
//     mode rules, CREATE_TASK marker spec).
//   • Subsequent turns — lightweight team/gap refresh + user message
//     only. The gateway already has the heavy preamble in its
//     per-sessionKey history.
//
// The empirically-validated framing (no `<occa-runtime>` XML tags;
// roleplay-style "You are X. Owner says: ...") is preserved from the
// previous chat-prompt-builder. Claude Sonnet 4.6 ignores XML rule
// blocks in user messages.

import type { ContextSpec, ContextTeammate } from "./spec";

function formatTeam(team: ContextTeammate[]): string {
  if (team.length === 0) {
    return `YOUR ACTIVE TEAM RIGHT NOW:\n- (empty — you are the only agent deployed)`;
  }
  const lines = [
    `YOUR ACTIVE TEAM RIGHT NOW (use the role key in CREATE_TASK.assignToRole):`,
  ];
  for (const m of team) {
    lines.push(`- ${m.name} · role: "${m.role}" · tier: ${m.tier}`);
  }
  return lines.join("\n");
}

function formatGaps(gaps: { role: string; tier: string }[]): string {
  if (gaps.length === 0) {
    return `ROLES YET TO BE DEPLOYED: (none — full org chart is staffed)`;
  }
  const heads: string[] = [];
  const directReports: string[] = [];
  const specialists: string[] = [];
  for (const g of gaps) {
    if (g.tier === "head") heads.push(g.role);
    else if (g.tier === "direct_report") directReports.push(g.role);
    else specialists.push(g.role);
  }
  const lines = [
    `ROLES YET TO BE DEPLOYED (default 35-persona org chart, owner deploys via the Agents window):`,
  ];
  if (heads.length > 0) lines.push(`  Heads: ${heads.join(", ")}`);
  if (directReports.length > 0)
    lines.push(`  Direct reports to you: ${directReports.join(", ")}`);
  if (specialists.length > 0)
    lines.push(`  Specialists: ${specialists.join(", ")}`);
  return lines.join("\n");
}

// Format Company Brain (Tier 3) as a labeled section per file. MVP
// strategy is full inline embed — agent reads everything in-prompt rather
// than calling a memory tool. Phase 2 may switch to directory-listing +
// on-demand `view` once the adapter contract exposes the memory tool API.
// Visibility is already enforced at loadContext, so anything reaching us
// is authorized for this agent.
function formatCompanyBrain(spec: ContextSpec): string | null {
  const brain = spec.knowledge?.brain;
  if (!brain || brain.length === 0) return null;
  const sections: string[] = [
    `COMPANY BRAIN — persistent knowledge about ${spec.company.name}.`,
    `Treat this as authoritative source-of-truth. When something here`,
    `conflicts with a casual claim in conversation, defer to the brain.`,
    ``,
  ];
  for (const file of brain) {
    sections.push(`### ${file.path}`);
    sections.push(file.content.trim());
    sections.push(``);
  }
  return sections.join("\n").trimEnd();
}

// Tier 3b — recent shipped work. Quick "what's been done lately" snapshot
// for chat surface so CEO can speak to active momentum without needing
// the owner to recap. Skipped entirely when no history exists yet.
function formatRecentWork(spec: ContextSpec): string | null {
  const recent = spec.history?.recentCompletedTasks;
  if (!recent || recent.length === 0) return null;
  const lines = [
    `RECENT WORK — last ${recent.length} shipped task${recent.length === 1 ? "" : "s"}:`,
  ];
  for (const t of recent) {
    const summary = t.summary.length > 200 ? `${t.summary.slice(0, 200)}…` : t.summary;
    lines.push(`  • Task #${t.taskNumber} "${t.title}" — ${summary.replace(/\n/g, " ")}`);
  }
  return lines.join("\n");
}

// Optional company profile block — only emit lines that have content,
// so blank onboarding doesn't spam the prompt with empty fields.
function formatCompanyProfile(spec: ContextSpec): string | null {
  const p = spec.company.profile;
  const lines: string[] = [];
  if (p.tagline) lines.push(`Tagline: ${p.tagline}`);
  if (p.niche) lines.push(`Niche: ${p.niche}`);
  if (p.brandVoice) lines.push(`Brand voice: ${p.brandVoice}`);
  if (p.contentPillars.length > 0)
    lines.push(`Content pillars: ${p.contentPillars.join(", ")}`);
  if (p.forbiddenWords.length > 0)
    lines.push(`Forbidden words / phrases: ${p.forbiddenWords.join(", ")}`);
  if (p.coverageScope) lines.push(`Coverage scope: ${p.coverageScope}`);
  if (p.coverageExcluded) lines.push(`Out of scope: ${p.coverageExcluded}`);
  if (lines.length === 0) return null;
  return [`COMPANY CONTEXT:`, ...lines.map((l) => `  ${l}`)].join("\n");
}

// Renders the full first-turn preamble.
function renderFirstTurnPrompt(spec: ContextSpec, userMessage: string): string {
  const profileBlock = formatCompanyProfile(spec);
  const brainBlock = formatCompanyBrain(spec);
  const recentWorkBlock = formatRecentWork(spec);
  return [
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — an AI agent running inside OCCA OS.`,
    ``,
    `Your full persona lives in your workspace files (./SOUL.md, ./AGENTS.md, ./IDENTITY.md, ./HEARTBEAT.md). Read them if you haven't this session.`,
    ``,
    `You are talking to the OWNER / FOUNDER of ${spec.company.name} — your principal. They built this company and you report directly to them. Treat their messages as principal-from-board direction, not customer support tickets.`,
    ``,
    ...(profileBlock ? [profileBlock, ``] : []),
    ...(brainBlock ? [brainBlock, ``] : []),
    ...(recentWorkBlock ? [recentWorkBlock, ``] : []),
    formatTeam(spec.org.team),
    ``,
    formatGaps(spec.org.gaps),
    ``,
    `HOW TO REPLY:`,
    `- BEGIN your very first reply by acknowledging your identity in your own persona voice (e.g. "Hey — ${spec.agent.name} here." or similar). DO NOT ask "who am I" or "who are you" — you already know.`,
    `- Use your CEO voice from ./SOUL.md: direct, action-oriented, no corporate warm-up, no exclamation points unless something is on fire.`,
    `- For ambiguous requests, ask 1-2 sharp clarifying questions. Multi-turn dialogue is normal and expected.`,
    ``,
    `CAPABILITY GAP CHECK (do this BEFORE confirming scope):`,
    `- Decide which role/department the request belongs to.`,
    `- If you have an active teammate above who fits → propose them by name when you confirm scope ("I'll have <name> handle this.").`,
    `- If the role exists in "ROLES YET TO BE DEPLOYED" but no one is staffed for it → DO NOT confirm scope or emit CREATE_TASK. Tell the owner explicitly: "This needs a <role> — can you deploy one via the Agents window? Once deployed, I'll pick it up."`,
    `- If the role is not in the org chart at all → tell the owner: "This needs a custom role we don't have. Either add a persona or drop the request." Don't proceed.`,
    `- NEVER plan to do the work yourself. You are router + reviewer, not IC.`,
    ``,
    `CONFIRM + EMIT FLOW:`,
    `- Once scope feels clear AND you have a capable teammate, RESTATE the scope in plain language and ask the owner explicitly — "Want me to kick this off with <name>?". DO NOT emit CREATE_TASK in the same reply where you propose the scope.`,
    `- ONLY after the owner explicitly confirms ("yes", "go", "do it", "proceed") do you emit CREATE_TASK — and the marker goes in the SAME reply that acknowledges the green light.`,
    `- If the owner declines or wants changes, keep refining via dialogue.`,
    ``,
    `CREATE_TASK MARKER (emit only after explicit owner confirmation):`,
    ``,
    `[[OCCA:CREATE_TASK]]`,
    `{`,
    `  "title": "<short imperative summary>",`,
    `  "brief": "<full agreed scope: deliverable, audience, deadline, constraints>",`,
    `  "assignToRole": "<role key from YOUR ACTIVE TEAM above — e.g. \"senior_writer\">",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:CREATE_TASK]]`,
    ``,
    `Body must be valid JSON. One marker per reply max. \`assignToRole\` MUST match a role string from YOUR ACTIVE TEAM exactly — not a free-text name like "Jhon" or a label like "writer". If you skip it, the task lands on you (the CEO) and you'll have to DELEGATE on next dispatch — which is a wasted hop. Always set assignToRole when you've confirmed who's doing the work. The runtime parses + strips the marker from the owner's view, so your surrounding prose is what they read. Never paste this syntax outside an actual emit.`,
    ``,
    `---`,
    ``,
    `Owner says:`,
    userMessage,
  ].join("\n");
}

// Renders a refresh prompt for subsequent turns. Lighter than first-turn
// preamble but still includes dynamic state that changes turn-to-turn —
// team + gaps (deploy/retire mid-conversation) and recent shipped work
// (task completions). Brain / profile stay in the gateway's session
// memory from the first-turn injection and don't need re-sending.
function renderRefreshTurn(spec: ContextSpec, userMessage: string): string {
  const recentWorkBlock = formatRecentWork(spec);
  return [
    `[Team snapshot — auto-refreshed]`,
    formatTeam(spec.org.team),
    ``,
    formatGaps(spec.org.gaps),
    ``,
    ...(recentWorkBlock ? [recentWorkBlock, ``] : []),
    `---`,
    ``,
    `Owner says:`,
    userMessage,
  ].join("\n");
}

export function renderChatPrompt(spec: ContextSpec): string {
  if (spec.surface.kind !== "chat") {
    throw new Error(
      `renderChatPrompt called with non-chat surface: ${spec.surface.kind}`,
    );
  }
  const { isFirstTurn, userMessage } = spec.surface;
  return isFirstTurn
    ? renderFirstTurnPrompt(spec, userMessage)
    : renderRefreshTurn(spec, userMessage);
}

