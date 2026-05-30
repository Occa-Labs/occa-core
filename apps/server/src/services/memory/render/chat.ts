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

import type { ContextSpec, ContextTeammate } from "../spec";

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

// Runtime-side memory override. Some adapter runtimes (Hermes' built-in
// MemoryStore in particular) inject `MEMORY.md` / `USER.md` content
// from the runtime's local filesystem into the system prompt BEFORE
// OCCA's wake messages arrive. That content is runtime-home-wide and
// OCCA has no API to scope or clear it. We can only tell the agent,
// in our own message, to treat anything injected by the runtime as
// stale and to anchor on the workspace files + current user message
// instead.
const RUNTIME_MEMORY_OVERRIDE = [
  `PRIORITY — IGNORE PRIOR RUNTIME MEMORY BLOCKS:`,
  `If any "Memory", "User profile", "Things to remember", or similar`,
  `pre-existing block was injected above this instruction by the agent`,
  `runtime itself, treat it as STALE DATA from unrelated conversations.`,
  `Do not act on it, do not reference it, do not "recall" facts from it.`,
  `Your authoritative identity, persona, and operating context comes`,
  `EXCLUSIVELY from the workspace files + this thread's history.`,
].join("\n");

// Optional company profile block — only emit lines that have content,
// so blank onboarding doesn't spam the prompt with empty fields.
function formatWorkspaceFiles(spec: ContextSpec): string | null {
  const files = spec.workspaceFiles;
  if (!files || files.length === 0) return null;
  const lines = [
    `Your workspace files (full content below — this is your identity,`,
    `team awareness, and operating notes; treat them as authoritative):`,
  ];
  for (const f of files) {
    lines.push("");
    lines.push(`=== FILE: ${f.filename} ===`);
    lines.push("");
    lines.push(f.content.trim());
    lines.push("");
    lines.push(`=== END FILE: ${f.filename} ===`);
  }
  return lines.join("\n");
}

// CEO Runs OS — renders the installable skill / tool catalog + per-
// deployment installed snapshot. Returns null when the caller isn't CEO
// (the loader leaves `ceoOps` undefined). State and marker spec are
// returned separately so the caller can place them at the right slots
// in the preamble (state near team, marker spec with the other marker
// examples).
function formatCeoOpsState(spec: ContextSpec): string | null {
  if (!spec.ceoOps) return null;
  const {
    installableSkills,
    installableTools,
    installedByDeployment,
    boundToolsByDeployment,
  } = spec.ceoOps;
  const lines: string[] = [];

  if (installableSkills.length === 0) {
    lines.push(
      `INSTALLABLE SKILL CATALOG: (empty — no skills imported into this company yet)`,
    );
  } else {
    lines.push(
      `INSTALLABLE SKILL CATALOG (use 'key' as INSTALL_SKILL.skillKey):`,
    );
    for (const s of installableSkills) {
      lines.push(`- key: ${s.key}`);
      lines.push(`  name: ${s.name}`);
      if (s.description) lines.push(`  description: ${s.description}`);
      const roleNote =
        s.allowedRoles.length === 0 ? "(any)" : s.allowedRoles.join(", ");
      lines.push(`  allowedRoles: ${roleNote}`);
    }
  }

  lines.push(``);
  if (installableTools.length === 0) {
    lines.push(
      `BINDABLE TOOL CATALOG: (empty — no tools configured for this company yet)`,
    );
  } else {
    lines.push(`BINDABLE TOOL CATALOG (use 'id' as BIND_TOOL.toolId):`);
    for (const t of installableTools) {
      lines.push(`- id: ${t.id}`);
      lines.push(`  label: ${t.label}`);
      lines.push(`  type: ${t.type}`);
      if (t.status !== "active") {
        lines.push(`  status: ${t.status} (binding allowed but invocation will fail)`);
      }
      const roleNote =
        t.allowedRoles.length === 0 ? "(any)" : t.allowedRoles.join(", ");
      lines.push(`  allowedRoles: ${roleNote}`);
    }
  }

  // Build a name lookup so the installed-map shows human names. CEO is
  // not in spec.org.team (team excludes self), so prepend agent itself
  // — CEO can install skills on its own deployment.
  const nameById = new Map<string, string>();
  nameById.set(spec.agent.id, spec.agent.name);
  for (const m of spec.org.team) nameById.set(m.id, m.name);

  // Tool label lookup for the bound-tools section (CEO sees labels not
  // UUIDs).
  const toolLabelById = new Map<string, string>();
  for (const t of installableTools) toolLabelById.set(t.id, t.label);

  lines.push(``);
  lines.push(`INSTALLED SKILLS PER AGENT:`);
  const ids = Object.keys(installedByDeployment).sort();
  if (ids.length === 0) {
    lines.push(`- (no active deployments)`);
  } else {
    for (const id of ids) {
      const name = nameById.get(id) ?? "(unknown)";
      const list = installedByDeployment[id];
      const skillList = list.length > 0 ? list.join(", ") : "(none)";
      lines.push(`- ${name} (id ${id}): ${skillList}`);
    }
  }

  lines.push(``);
  lines.push(`BOUND TOOLS PER AGENT:`);
  if (ids.length === 0) {
    lines.push(`- (no active deployments)`);
  } else {
    for (const id of ids) {
      const name = nameById.get(id) ?? "(unknown)";
      const list = boundToolsByDeployment[id] ?? [];
      const labels =
        list.length > 0
          ? list.map((tid) => toolLabelById.get(tid) ?? tid).join(", ")
          : "(none)";
      lines.push(`- ${name} (id ${id}): ${labels}`);
    }
  }

  lines.push(``);
  if (spec.ceoOps.channels.length === 0) {
    lines.push(
      `YOUR CHANNELS: (none connected — operator sets these up in the Channels window)`,
    );
  } else {
    lines.push(`YOUR CHANNELS:`);
    for (const c of spec.ceoOps.channels) {
      const flags = [
        c.enabled ? "enabled" : "disabled",
        `status=${c.status}`,
      ].join(", ");
      lines.push(`- ${c.channelType} — ${flags}`);
    }
  }

  lines.push(``);
  if (spec.ceoOps.workflows.length === 0) {
    lines.push(`COMPANY WORKFLOWS: (none defined yet)`);
  } else {
    lines.push(`COMPANY WORKFLOWS (use 'yamlId' as TOGGLE_WORKFLOW.workflowYamlId):`);
    for (const w of spec.ceoOps.workflows) {
      const state = w.enabled ? "enabled" : "disabled";
      const desc = w.description ? ` — ${w.description}` : "";
      lines.push(`- yamlId: ${w.yamlId}`);
      lines.push(`  name: ${w.name} (${state})${desc}`);
    }
  }

  lines.push(``);
  if (spec.ceoOps.routines.length === 0) {
    lines.push(`COMPANY ROUTINES: (none defined yet)`);
  } else {
    lines.push(`COMPANY ROUTINES (use 'id' as TOGGLE_ROUTINE.routineId):`);
    for (const r of spec.ceoOps.routines) {
      const assignee =
        r.assigneeDeploymentId !== null
          ? (nameById.get(r.assigneeDeploymentId) ?? "(unknown agent)")
          : "(unassigned)";
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`- id: ${r.id}`);
      lines.push(
        `  title: ${r.title} (${r.status}, ${r.triggerSummary}, assignee: ${assignee})${desc}`,
      );
    }
  }

  // Who already fills each role, so the CEO never proposes a duplicate of
  // a singleton role that's taken. Team excludes self (CEO), which is fine
  // since ceo is not a proposable role.
  const occupancyByRole = new Map<string, string[]>();
  for (const m of spec.org.team) {
    const names = occupancyByRole.get(m.role) ?? [];
    names.push(m.name);
    occupancyByRole.set(m.role, names);
  }

  lines.push(``);
  lines.push(
    `PROPOSABLE ROLES (use 'key' as PROPOSE_DEPLOYMENT.role — the only roles you may propose). A role marked ALREADY DEPLOYED is filled: NEVER propose a duplicate of a singleton (head_* / c-suite) role; only propose another of a non-singleton role if the owner explicitly asks for an additional one:`,
  );
  for (const r of spec.ceoOps.proposableRoles) {
    const filledBy = occupancyByRole.get(r.key) ?? [];
    let line = `- key: ${r.key} (${r.label}, tier ${r.tier})`;
    if (filledBy.length > 0) {
      const taken = r.singleton
        ? " — TAKEN, do not propose (one per company)"
        : "";
      line += ` — ALREADY DEPLOYED: ${filledBy.join(", ")}${taken}`;
    }
    lines.push(line);
    if (r.description) lines.push(`  ${r.description}`);
  }

  lines.push(``);
  const runtimeTypes = spec.ceoOps.proposableRuntimes.map((rt) => rt.type);
  lines.push(
    `PROPOSABLE RUNTIMES (use one as PROPOSE_DEPLOYMENT.runtime): ${
      runtimeTypes.length > 0 ? runtimeTypes.join(", ") : "(none registered)"
    }`,
  );

  return lines.join("\n");
}

function formatInstallSkillMarkerSpec(spec: ContextSpec): string | null {
  if (!spec.ceoOps) return null;
  return [
    `INSTALL_SKILL MARKER (use when the owner asks to install a skill on an agent):`,
    `- Look up the target agent's deployment uuid from YOUR ACTIVE TEAM above (or use your own id if installing on yourself).`,
    `- Look up the exact skill key from INSTALLABLE SKILL CATALOG above. Do NOT invent keys — if the catalog is empty for the owner's request, say so and stop.`,
    `- Respect each skill's allowedRoles: only suggest or install a skill on an agent whose role is in that skill's allowedRoles. allowedRoles '(any)' means no restriction. Do NOT offer a skill the target's role isn't allowed — it will be rejected.`,
    `- One marker per (agent, skill). Multiple markers per reply are allowed when the owner asks for several installs at once.`,
    `- This is auto-executed. Do not ask for confirmation. Do not write a fake "✓" in your prose — the runtime appends the receipt automatically.`,
    `- Skill activates on the target agent's NEXT task, not retroactively.`,
    ``,
    `[[OCCA:INSTALL_SKILL]]`,
    `{`,
    `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
    `  "skillKey": "<key from INSTALLABLE SKILL CATALOG above>"`,
    `}`,
    `[[/OCCA:INSTALL_SKILL]]`,
    ``,
    `UNINSTALL_SKILL MARKER (use when the owner asks to remove a skill from an agent):`,
    `- Same shape as INSTALL_SKILL. Look up the deployment uuid from YOUR ACTIVE TEAM and use the exact skill key from the INSTALLED SKILLS PER AGENT list above.`,
    `- Auto-executed, idempotent — if the key isn't on the agent the runtime returns a "wasn't installed" ack with no error.`,
    `- Removal takes effect on the target agent's NEXT task.`,
    ``,
    `[[OCCA:UNINSTALL_SKILL]]`,
    `{`,
    `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
    `  "skillKey": "<key currently installed on that deployment>"`,
    `}`,
    `[[/OCCA:UNINSTALL_SKILL]]`,
    ``,
    `BIND_TOOL MARKER (use when the owner asks to give an agent access to a tool):`,
    `- Look up the target agent's deployment uuid from YOUR ACTIVE TEAM above.`,
    `- Look up the tool UUID ('id') from BINDABLE TOOL CATALOG above. NEVER invent UUIDs — if the catalog is empty for the owner's request, say so and stop.`,
    `- One marker per (agent, tool). Multiple markers per reply are allowed.`,
    `- Auto-executed. Tool becomes available to the agent on its NEXT task.`,
    `- Tool credentials are NOT set via this marker — operator configures them in the Tools window. You can only bind tools that are already provisioned.`,
    ``,
    `[[OCCA:BIND_TOOL]]`,
    `{`,
    `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
    `  "toolId": "<id from BINDABLE TOOL CATALOG above>"`,
    `}`,
    `[[/OCCA:BIND_TOOL]]`,
    ``,
    `UNBIND_TOOL MARKER (use when the owner asks to remove a tool from an agent):`,
    `- Same shape as BIND_TOOL. Use the tool UUID from BOUND TOOLS PER AGENT list above.`,
    `- Auto-executed, idempotent.`,
    ``,
    `[[OCCA:UNBIND_TOOL]]`,
    `{`,
    `  "deploymentId": "<deployment uuid from YOUR ACTIVE TEAM above>",`,
    `  "toolId": "<id currently bound to that deployment>"`,
    `}`,
    `[[/OCCA:UNBIND_TOOL]]`,
    ``,
    `TOGGLE_CHANNEL MARKER (use when the owner asks to turn a channel on or off):`,
    `- Use the channelType string from YOUR CHANNELS above (e.g. "telegram").`,
    `- 'enabled: true' turns the channel back on, 'enabled: false' silences it. Credentials stay intact either way — operator can toggle back without re-setting up.`,
    `- Auto-executed, idempotent (re-emitting the same value just re-confirms).`,
    `- If the channel is NOT in YOUR CHANNELS yet, do NOT emit. Tell the owner they need to connect it from the Channels window first; credentials are never set via chat.`,
    ``,
    `[[OCCA:TOGGLE_CHANNEL]]`,
    `{`,
    `  "channelType": "<channelType from YOUR CHANNELS above>",`,
    `  "enabled": true | false`,
    `}`,
    `[[/OCCA:TOGGLE_CHANNEL]]`,
    ``,
    `TOGGLE_WORKFLOW MARKER (use when the owner asks to enable or pause a workflow):`,
    `- Use the workflow yamlId from COMPANY WORKFLOWS above.`,
    `- 'enabled: true' resumes the workflow, 'enabled: false' pauses it. YAML definition stays intact — operator can resume without re-defining.`,
    `- Auto-executed, idempotent.`,
    `- If yamlId is NOT in COMPANY WORKFLOWS, do NOT emit. Tell the owner the workflow doesn't exist yet — they need to create it from the Workflows window.`,
    ``,
    `[[OCCA:TOGGLE_WORKFLOW]]`,
    `{`,
    `  "workflowYamlId": "<yamlId from COMPANY WORKFLOWS above>",`,
    `  "enabled": true | false`,
    `}`,
    `[[/OCCA:TOGGLE_WORKFLOW]]`,
    ``,
    `TOGGLE_ROUTINE MARKER (use when the owner asks to pause or resume a routine):`,
    `- Use the routine id (UUID) from COMPANY ROUTINES above. Routines have no slug; the UUID is the address.`,
    `- 'active: true' resumes, 'active: false' pauses. Triggers and assignee stay intact — only the routine status flips.`,
    `- Auto-executed, idempotent.`,
    `- Archived routines cannot be flipped from chat; tell the owner to restore from the Routines window first.`,
    ``,
    `[[OCCA:TOGGLE_ROUTINE]]`,
    `{`,
    `  "routineId": "<id from COMPANY ROUTINES above>",`,
    `  "active": true | false`,
    `}`,
    `[[/OCCA:TOGGLE_ROUTINE]]`,
    ``,
    `DISPATCH_ROUTINE MARKER (use when the owner asks to FIRE a routine NOW, ahead of its schedule):`,
    `- This is CONFIRM-TIER. Follow CONFIRM + EMIT FLOW above: restate what you'd run, ask "Want me to fire it now?", and ONLY emit once the owner says yes/go/proceed.`,
    `- Routine must already be active and have an assignee. Paused/archived routines must be resumed first; unassigned routines need an assignee in the Routines window.`,
    `- A wrapper task is created and the assignee wakes up immediately to execute. Production impact — agent run consumes resources.`,
    `- The runtime de-dupes manual dispatches within a 5-minute window. If you ask twice quickly, the second one is rejected as already_running.`,
    ``,
    `[[OCCA:DISPATCH_ROUTINE]]`,
    `{`,
    `  "routineId": "<id from COMPANY ROUTINES above>"`,
    `}`,
    `[[/OCCA:DISPATCH_ROUTINE]]`,
    ``,
    `ASSIGN_ROUTINE MARKER (use when the owner asks to change who runs a routine):`,
    `- Use the routine id (UUID) from COMPANY ROUTINES above, and the deployment uuid of the new assignee from YOUR ACTIVE TEAM above.`,
    `- Pass 'assigneeDeploymentId: null' to clear the assignee — the routine effectively pauses on next firing.`,
    `- Auto-executed, idempotent. In-flight wrapper tasks already dispatched stay with their current assignee; only future firings move.`,
    ``,
    `[[OCCA:ASSIGN_ROUTINE]]`,
    `{`,
    `  "routineId": "<id from COMPANY ROUTINES above>",`,
    `  "assigneeDeploymentId": "<deployment uuid from YOUR ACTIVE TEAM, or null>"`,
    `}`,
    `[[/OCCA:ASSIGN_ROUTINE]]`,
    ``,
    `PROPOSE_DEPLOYMENT MARKER (use when the owner asks to add / deploy a new agent):`,
    `- This does NOT deploy. It creates a PROPOSAL the owner opens in the Approvals window ("Deploy this"), where THEY enter the gateway endpoint + token and sign. Nothing is provisioned from chat.`,
    `- You NEVER supply a gateway URL, an API key / token, or a signature — those are operator-only, entered in the OS. If the owner pastes a token in chat, refuse it and tell them to enter it in the deploy modal.`,
    `- 'role' MUST be a key from PROPOSABLE ROLES above. 'runtime' MUST be one from PROPOSABLE RUNTIMES above. Do NOT invent either — if what the owner wants isn't in the catalog, say so and stop.`,
    `- 'skills' is optional: keys from INSTALLABLE SKILL CATALOG above that the proposed role is allowed to use. Omit or pass [] if unsure.`,
    `- 'suggestedName' MUST be a realistic HUMAN persona name in the same style as YOUR ACTIVE TEAM above (a first + last name like "Noa Reinhardt" or a single given name like "Juno") — NEVER the role title or a job label like "On-chain Analyst". Invent a fresh name that isn't already on the team. The owner can rename in the modal.`,
    `- Auto-creates the proposal on emit. After it, tell the owner you've queued it and they can deploy it from the Approvals window. Do NOT write a fake "✓" — the runtime appends the receipt.`,
    ``,
    `[[OCCA:PROPOSE_DEPLOYMENT]]`,
    `{`,
    `  "role": "<key from PROPOSABLE ROLES above>",`,
    `  "runtime": "<type from PROPOSABLE RUNTIMES above>",`,
    `  "skills": ["<optional keys from INSTALLABLE SKILL CATALOG above>"],`,
    `  "suggestedName": "<optional display name>"`,
    `}`,
    `[[/OCCA:PROPOSE_DEPLOYMENT]]`,
  ].join("\n");
}

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
  const workspaceFilesBlock = formatWorkspaceFiles(spec);
  const ceoOpsStateBlock = formatCeoOpsState(spec);
  const installSkillSpecBlock = formatInstallSkillMarkerSpec(spec);
  return [
    RUNTIME_MEMORY_OVERRIDE,
    ``,
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — an AI agent running inside OCCA OS.`,
    ``,
    `You are talking to the OWNER / FOUNDER of ${spec.company.name} — your principal. They built this company and you report directly to them. Treat their messages as principal-from-board direction, not customer support tickets.`,
    ``,
    ...(workspaceFilesBlock ? [workspaceFilesBlock, ``] : []),
    ...(profileBlock ? [profileBlock, ``] : []),
    ...(brainBlock ? [brainBlock, ``] : []),
    ...(recentWorkBlock ? [recentWorkBlock, ``] : []),
    formatTeam(spec.org.team),
    ``,
    formatGaps(spec.org.gaps),
    ``,
    ...(ceoOpsStateBlock ? [ceoOpsStateBlock, ``] : []),
    `HOW TO REPLY:`,
    `- BEGIN your very first reply by acknowledging your identity in your own persona voice (e.g. "Hey — ${spec.agent.name} here." or similar). DO NOT ask "who am I" or "who are you" — you already know.`,
    `- Use your CEO voice from SOUL above: direct, action-oriented, no corporate warm-up, no exclamation points unless something is on fire.`,
    `- For ambiguous requests, ask 1-2 sharp clarifying questions. Multi-turn dialogue is normal and expected.`,
    ``,
    `STATUS / LIST / INFO REPLIES — KEEP TIGHT:`,
    `When the owner asks a STATUS or LIST question (e.g. "what skills are available", "list my agents", "what tools do I have", "who is on the team", "what's the current state"), answer with a CONCISE summary, then offer the next action.`,
    `- Group items by category (3-5 lines max per category).`,
    `- Skip descriptions for items the owner already knows about — name + a 3-5 word hint is enough.`,
    `- End with ONE concrete offer: "Want me to install X on Y?", "Want me to deploy Z?", "Want a breakdown of one of these?".`,
    `- Do NOT dump the full catalog or copy the entire prompt context back at the owner. The runtime suppresses dumps over ~2500 chars; tight summary lands well under that.`,
    `- Surfacing the answer is the job, but BREVITY is the standard.`,
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
    `Body must be valid JSON. One DELEGATE or CREATE_TASK marker per reply max. When the task completes (whether the teammate finished it or you finished it yourself), the synthesized result lands here in chat automatically — you do not need to emit a second turn to "report back". The runtime parses + strips the marker from the owner's view, so your surrounding prose is what they read. Never paste this syntax outside an actual emit.`,
    ``,
    ...(installSkillSpecBlock ? [installSkillSpecBlock, ``] : []),
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
  const ceoOpsStateBlock = formatCeoOpsState(spec);
  return [
    `[Team snapshot — auto-refreshed]`,
    formatTeam(spec.org.team),
    ``,
    formatGaps(spec.org.gaps),
    ``,
    ...(ceoOpsStateBlock ? [ceoOpsStateBlock, ``] : []),
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
  const workspaceFilesBlock = formatWorkspaceFiles(spec);
  return [
    RUNTIME_MEMORY_OVERRIDE,
    ``,
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — an AI agent running inside OCCA OS.`,
    ``,
    `You have just received a DIRECTIVE from ${args.callerName} (${args.callerRole}), who sits one tier up in your reporting chain. Treat it as direction you are accountable to deliver against. The owner does NOT see this surface — your reply lands with ${args.callerName}, not the owner.`,
    ``,
    ...(workspaceFilesBlock ? [workspaceFilesBlock, ``] : []),
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

