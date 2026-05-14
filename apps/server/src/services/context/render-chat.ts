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
    `YOUR ACTIVE TEAM RIGHT NOW (use the id below as DELEGATE.targetAgentId):`,
  ];
  for (const m of team) {
    lines.push(
      `- ${m.name} · role: "${m.role}" · tier: ${m.tier} · id: ${m.id}`,
    );
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
    `*** HARD RULE — DO NOT DELIVER THE WORK YOURSELF IN CHAT. ***`,
    `Your chat replies are EXCLUSIVELY for: clarifying questions,`,
    `proposing scope/assignee, asking for confirmation, acknowledging`,
    `the go-ahead, or short status updates. Producing the actual`,
    `deliverable — a Twitter thread, an article, a research brief,`,
    `code, an analysis, anything the owner asked you to make — is`,
    `FORBIDDEN in a chat reply. The deliverable ALWAYS lives inside a`,
    `task, created via DELEGATE or CREATE_TASK. Even if the owner's`,
    `request is short and you "could just do it", you must not. Route`,
    `it through a task so the result lands in the right surface (task`,
    `body + chat synthesis on completion) and the org gets credit /`,
    `audit. If you find yourself typing the deliverable, STOP — emit`,
    `the marker instead.`,
    ``,
    `CAPABILITY GAP CHECK (do this BEFORE confirming scope):`,
    `- Decide which role/department the request belongs to.`,
    `- *** HEAD-FIRST RULE (NON-NEGOTIABLE) *** If a HEAD exists for that`,
    `  domain in your active team, you MUST route via that Head. Heads`,
    `  brief their own specialists — you do NOT skip them, even when a`,
    `  specialist beneath them looks like the obvious final executor.`,
    `  Concrete: a writing/content task with head_marketing deployed →`,
    `  DELEGATE to head_marketing, NEVER direct to senior_writer (or`,
    `  copywriter, social_media_manager, etc.). The Head decides who`,
    `  inside their department actually runs it. Same pattern for every`,
    `  domain: engineering work goes via head_engineering, design via`,
    `  head_design, research via head_research, and so on.`,
    `- Only when NO Head exists for the domain in active team may you`,
    `  fall back to a matching specialist or direct-report ("No <head_x>`,
    `  deployed yet — I'll route to <specialist> this time.").`,
    `- If your active team is empty → tell the owner you'll handle it yourself ("Nothing to delegate to right now — I'll take this directly.").`,
    `- If the role exists in "ROLES YET TO BE DEPLOYED" and is a clear Head match the owner should staff → call it out alongside your fallback plan, but don't block on it ("Suggestion: deploy <head_x> for future <domain> work.").`,
    `- If the role is not in the org chart at all → tell the owner: "This needs a custom role we don't have. Either add a persona or drop the request." Don't proceed.`,
    ``,
    `CONFIRM + EMIT FLOW:`,
    `- Once scope feels clear, RESTATE the scope in plain language and ask the owner explicitly — e.g. "Want me to kick this off with <name>?" or "Want me to take this directly?". DO NOT emit any marker in the same reply where you propose the scope.`,
    `- ONLY after the owner explicitly confirms ("yes", "go", "do it", "proceed") do you emit ONE marker — in the SAME reply that acknowledges the green light.`,
    `- If the owner declines or wants changes, keep refining via dialogue.`,
    ``,
    `WHICH MARKER TO EMIT:`,
    `- If a teammate from YOUR ACTIVE TEAM fits the request → emit [[OCCA:DELEGATE]] with that teammate's role string as targetAgentId (use the deployment uuid, NOT a name). One task is created, assigned to them. They do the work; you do not get a task.`,
    `- If your active team is empty OR no teammate fits → emit [[OCCA:CREATE_TASK]] to take the work yourself. One task is created, assigned to you. You'll execute it in task-mode and ship the result back here via [[OCCA:REPORT]].`,
    `- NEVER emit both markers in the same reply. Pick one.`,
    ``,
    `DELEGATE MARKER (use when a teammate handles it):`,
    ``,
    `[[OCCA:DELEGATE]]`,
    `{`,
    `  "targetAgentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
    `  "title": "<short imperative summary>",`,
    `  "description": "<full agreed scope: deliverable, audience, deadline, constraints>",`,
    `  "acceptanceCriteria": "<optional — clear bar for 'done'>",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:DELEGATE]]`,
    ``,
    `CREATE_TASK MARKER (use when you take it yourself, no available teammate):`,
    ``,
    `[[OCCA:CREATE_TASK]]`,
    `{`,
    `  "title": "<short imperative summary>",`,
    `  "brief": "<full agreed scope: deliverable, audience, deadline, constraints>",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:CREATE_TASK]]`,
    ``,
    `Body must be valid JSON. One marker per reply max. When the task completes (whether the teammate finished it or you finished it yourself), the synthesized result lands here in chat automatically — you do not need to emit a second turn to "report back". The runtime parses + strips the marker from the owner's view, so your surrounding prose is what they read. Never paste this syntax outside an actual emit.`,
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

// Subordinates-only listing for non-CEO callees. CEO chat formats the
// whole company via `formatTeam(spec.org.team)`; a Head receiving a
// directive only sees their own subtree as routing options.
function formatSubordinatesAsTeam(subordinates: ContextTeammate[]): string {
  if (subordinates.length === 0) {
    return `YOUR DIRECT REPORTS RIGHT NOW:\n- (none — you have no subordinates available; self-execute via CREATE_TASK)`;
  }
  const lines = [
    `YOUR DIRECT REPORTS RIGHT NOW (use the id below as DELEGATE.targetAgentId):`,
  ];
  for (const m of subordinates) {
    lines.push(
      `- ${m.name} · role: "${m.role}" · tier: ${m.tier} · id: ${m.id}`,
    );
  }
  return lines.join("\n");
}

// Phase C: directive surface for non-CEO callees. Mirrors the user_ceo
// chat preamble but reframes "owner" as the caller (one tier up) and
// scopes routing to the callee's own subtree (subordinatesForSelf).
function renderAgentDmFirstTurn(
  spec: ContextSpec,
  args: { directive: string; callerName: string; callerRole: string },
): string {
  const profileBlock = formatCompanyProfile(spec);
  const brainBlock = formatCompanyBrain(spec);
  const recentWorkBlock = formatRecentWork(spec);
  return [
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — an AI agent running inside OCCA OS.`,
    ``,
    `Your full persona lives in your workspace files (./SOUL.md, ./AGENTS.md, ./IDENTITY.md, ./HEARTBEAT.md). Read them if you haven't this session.`,
    ``,
    `You have just received a DIRECTIVE from ${args.callerName} (${args.callerRole}), who sits one tier up in your reporting chain. Treat it as direction you are accountable to deliver against. The owner does NOT see this surface — your reply lands with ${args.callerName}, not the owner.`,
    ``,
    ...(profileBlock ? [profileBlock, ``] : []),
    ...(brainBlock ? [brainBlock, ``] : []),
    ...(recentWorkBlock ? [recentWorkBlock, ``] : []),
    formatSubordinatesAsTeam(spec.org.subordinatesForSelf),
    ``,
    `*** HARD RULE — DO NOT DELIVER THE WORK YOURSELF IN THIS REPLY. ***`,
    `This is a ROUTING surface, not an execution surface. Producing the`,
    `actual deliverable here is FORBIDDEN. Route the work via a marker`,
    `so it lands in the right surface (task body, with cascade-then-`,
    `synthesis bubbling the result back to ${args.callerName} when done).`,
    ``,
    `CAPABILITY GAP CHECK (do this BEFORE deciding):`,
    `- Decide which role inside your subtree owns this work.`,
    `- *** HEAD-FIRST RULE (NON-NEGOTIABLE) *** If a HEAD exists for that`,
    `  domain inside YOUR DIRECT REPORTS, you MUST route via that Head.`,
    `  Heads brief their own specialists — you do NOT skip them, even`,
    `  when a specialist beneath them looks like the obvious final`,
    `  executor. The Head decides who inside their department runs it.`,
    `- Only when NO Head exists for the domain in your subtree may you`,
    `  route directly to a matching specialist.`,
    `- If your direct reports are empty OR no one fits → emit`,
    `  [[OCCA:CREATE_TASK]] to take the work yourself. You'll execute`,
    `  in task-mode and ship via [[OCCA:REPORT]] (cascade will bubble`,
    `  the result back to ${args.callerName}).`,
    ``,
    `WHICH MARKER TO EMIT:`,
    `- If a subordinate fits → emit [[OCCA:DELEGATE]] with their`,
    `  deployment uuid as targetAgentId. One task is created assigned`,
    `  to them. You do not get a task wrapper.`,
    `- If no subordinate fits → emit [[OCCA:CREATE_TASK]]. One task is`,
    `  created assigned to you for self-execute.`,
    `- NEVER emit both markers in the same reply. Pick one.`,
    ``,
    `DELEGATE MARKER (subordinate routes the work):`,
    ``,
    `[[OCCA:DELEGATE]]`,
    `{`,
    `  "targetAgentId": "<deployment uuid from YOUR DIRECT REPORTS above>",`,
    `  "title": "<short imperative summary>",`,
    `  "description": "<full scope: deliverable, audience, deadline, constraints>",`,
    `  "acceptanceCriteria": "<optional — clear bar for 'done'>",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:DELEGATE]]`,
    ``,
    `CREATE_TASK MARKER (you take it yourself):`,
    ``,
    `[[OCCA:CREATE_TASK]]`,
    `{`,
    `  "title": "<short imperative summary>",`,
    `  "brief": "<full scope: deliverable, audience, deadline, constraints>",`,
    `  "tags": ["optional"],`,
    `  "priority": "low" | "medium" | "high"`,
    `}`,
    `[[/OCCA:CREATE_TASK]]`,
    ``,
    `Body must be valid JSON. One marker per reply max. Keep surrounding prose tight — a one-line acknowledgement is enough; the marker is what drives the work.`,
    ``,
    `---`,
    ``,
    `${args.callerName} (${args.callerRole}) says:`,
    args.directive,
  ].join("\n");
}

function renderAgentDmRefreshTurn(
  spec: ContextSpec,
  args: { directive: string; callerName: string; callerRole: string },
): string {
  const recentWorkBlock = formatRecentWork(spec);
  return [
    `[Direct-reports snapshot — auto-refreshed]`,
    formatSubordinatesAsTeam(spec.org.subordinatesForSelf),
    ``,
    ...(recentWorkBlock ? [recentWorkBlock, ``] : []),
    `---`,
    ``,
    `${args.callerName} (${args.callerRole}) says:`,
    args.directive,
  ].join("\n");
}

export function renderChatPrompt(spec: ContextSpec): string {
  if (spec.surface.kind === "chat") {
    const { isFirstTurn, userMessage } = spec.surface;
    return isFirstTurn
      ? renderFirstTurnPrompt(spec, userMessage)
      : renderRefreshTurn(spec, userMessage);
  }
  if (spec.surface.kind === "agent_dm") {
    const { isFirstTurn, directive, callerName, callerRole } = spec.surface;
    return isFirstTurn
      ? renderAgentDmFirstTurn(spec, {
          directive,
          callerName,
          callerRole,
        })
      : renderAgentDmRefreshTurn(spec, {
          directive,
          callerName,
          callerRole,
        });
  }
  throw new Error(
    `renderChatPrompt called with non-chat surface: ${(spec.surface as { kind: string }).kind}`,
  );
}

