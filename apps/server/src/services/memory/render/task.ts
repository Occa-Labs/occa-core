// Task-surface renderer for the Context Pipeline.
//
// Mirrors the previous `features/tasks/services/prompt-builder.ts:buildTaskPrompt`
// but reads from a `ContextSpec` rather than ad-hoc args. Dispatcher
// calls `loadTaskSurfacePayload()` to gather task-specific data, then
// `loadContext({ surface: { kind: "task", ... }})` for the agent
// state, then `renderTaskPrompt(spec)` to emit the wake message.

import { and, eq, inArray } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  tasks,
} from "@occa/shared/schema";
import type { ContentBlock, Task } from "@occa/shared/types";
import { getTier } from "@occa/shared/role-catalog";
import { db } from "../../../infra/database/client";
import {
  renderReportsBlock,
  renderRootReportBlock,
} from "../../delegation/policy";
import { listTaskCommentsByTask } from "../../../features/tasks/repositories/task-comments";
import type { ContextSpec, SurfacePayload } from "../spec";

// Max chars per completed-child preview surfaced to the parent agent.
// Sized for ~1-2 short pages of prose — long enough for a CEO to
// synthesize a Writer's draft, short enough to keep total prompt cost
// bounded when 4-5 specialists report in. Truncation is suffixed "…"
// so the agent knows the snippet was clipped.
const CHILD_RESULT_PREVIEW_MAX = 4_000;

// Most-recent task comments surfaced to the agent. A bounce posts one
// comment per failed attempt; a handful of recent ones is plenty of
// feedback context without bloating the prompt.
const COMMENT_RENDER_LIMIT = 6;

// Per-comment body cap in the rendered prompt.
const COMMENT_BODY_MAX = 800;

// Skill inlining budget. Context is a finite resource — inlining every
// assigned skill's full markdown on every wake drowns the actual task brief
// (measured: 8 skills = 220KB, 89% of one news_writer prompt, brief itself
// 0.5%). So inline small, high-signal skills verbatim and pointer-truncate
// large ones to fetch-on-demand (progressive disclosure). See
// docs/context-engineering.md.
//
// Under this byte cap → inline whole (keeps small editorial/fact-check
// skills unavoidable, the property the previous always-inline design cared
// about). Over it → header slice + fetch pointer.
const SKILL_INLINE_CAP = 12_000;
// Total budget across all inlined skill bodies. Once exceeded, remaining
// skills are pointer-only regardless of individual size — bounds worst-case
// prompt growth as an agent accrues skills. desiredSkills order is priority
// order, so the highest-priority skills win the budget.
const SKILLS_TOTAL_BUDGET = 48_000;
// Header slice kept when a skill is pointer-truncated: enough for the
// frontmatter + description + opening section so the agent knows what the
// skill does and when to pull the rest.
const SKILL_HEADER_SLICE = 2_000;

function blocksToMarkdown(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading_1":
          return `# ${b.text}`;
        case "heading_2":
          return `## ${b.text}`;
        case "heading_3":
          return `### ${b.text}`;
        case "bullet":
          return `- ${b.text}`;
        case "checklist":
          return `- [${b.checked ? "x" : " "}] ${b.text}`;
        case "quote":
          return `> ${b.text}`;
        case "code":
          return `\`\`\`\n${b.text}\n\`\`\``;
        case "divider":
          return "---";
        case "paragraph":
          return b.text;
        case "agent_result":
          return ""; // skip prior outputs
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

interface CompletedChildRef {
  taskNumber: number;
  title: string;
  agentName: string | null;
  resultPreview: string | null;
}

async function loadCompletedChildren(
  parentTaskId: string,
): Promise<CompletedChildRef[]> {
  const rows = await db
    .select({
      taskNumber: tasks.taskNumber,
      title: tasks.title,
      blocks: tasks.blocks,
      assignedDeploymentId: tasks.assignedDeploymentId,
    })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.status, "done")));
  if (rows.length === 0) return [];

  const deploymentIds = Array.from(
    new Set(
      rows
        .map((r) => r.assignedDeploymentId)
        .filter((id): id is string => id !== null),
    ),
  );
  const nameByDeployment = new Map<string, string>();
  if (deploymentIds.length > 0) {
    const fetched = await db
      .select({ id: deployments.id, name: agentIdentities.name })
      .from(deployments)
      .innerJoin(
        agentIdentities,
        eq(deployments.agentIdentityId, agentIdentities.id),
      )
      .where(inArray(deployments.id, deploymentIds));
    for (const a of fetched) nameByDeployment.set(a.id, a.name);
  }

  return rows.map((r) => {
    const blocks = (r.blocks as ContentBlock[]) ?? [];
    const result = blocks.find((b) => b.type === "agent_result");
    const preview =
      result && result.type === "agent_result" ? result.preview : null;
    return {
      taskNumber: r.taskNumber,
      title: r.title,
      agentName: r.assignedDeploymentId
        ? (nameByDeployment.get(r.assignedDeploymentId) ?? null)
        : null,
      resultPreview: preview,
    };
  });
}

// Builds the task-surface payload — task header data, body markdown,
// and recently-completed children. Caller passes this to `loadContext`
// as `surface` so the renderer has everything it needs.
export async function loadTaskSurfacePayload(args: {
  task: Task;
  assigneeRole: string;
  traceId: string;
  gatewayUrl: string | null;
}): Promise<SurfacePayload> {
  const blocks = (args.task.blocks ?? []) as ContentBlock[];
  const bodyMarkdown = blocksToMarkdown(blocks);
  const completedChildren = await loadCompletedChildren(args.task.id);
  const commentRows = await listTaskCommentsByTask(
    args.task.id,
    args.task.companyId,
  );
  const comments = commentRows.slice(-COMMENT_RENDER_LIMIT).map((c) => ({
    from:
      c.authorDeploymentId === null && c.authorUserId === null
        ? ("system" as const)
        : ("teammate" as const),
    body: c.body,
  }));
  return {
    kind: "task",
    taskId: args.task.id,
    taskNumber: args.task.taskNumber,
    title: args.task.title,
    priority: args.task.priority,
    taskType: args.task.taskType,
    effortLevel: args.task.effortLevel,
    tags: args.task.tags ?? [],
    bodyMarkdown,
    acceptanceCriteria: args.task.acceptanceCriteria ?? null,
    traceId: args.traceId,
    gatewayUrl: args.gatewayUrl,
    isRoot: args.task.parentTaskId === null,
    isCeoAssignee: getTier(args.assigneeRole) === "ceo",
    completedChildren,
    comments,
  };
}

function renderCompletedChildrenBlock(
  children: CompletedChildRef[],
): string {
  if (children.length === 0) return "";
  const lines = [
    `RECENT ACTIVITY — child tasks that completed since you last looked:`,
    ``,
  ];
  for (const c of children) {
    const who = c.agentName ?? "agent";
    lines.push(`  • Task #${c.taskNumber} "${c.title}" — completed by ${who}`);
    if (c.resultPreview) {
      const trimmed = c.resultPreview
        .slice(0, CHILD_RESULT_PREVIEW_MAX)
        .replace(/\n/g, " ");
      lines.push(
        `      result: ${trimmed}${
          c.resultPreview.length > CHILD_RESULT_PREVIEW_MAX ? "…" : ""
        }`,
      );
    }
  }
  lines.push(
    ``,
    `Synthesize what they shipped. If the parent task is now satisfied,`,
    `produce the closing summary and let the task auto-close. If more work`,
    `is needed, request another DELEGATE.`,
  );
  return lines.join("\n");
}

// Renders recent task comments — reviewer / system feedback the agent
// must act on. A verification-gate bounce lands here; placing it right
// before the brief keeps it impossible to miss.
function renderCommentsBlock(
  comments: { from: "system" | "teammate"; body: string }[],
): string {
  if (comments.length === 0) return "";
  const lines = [
    `FEEDBACK ON THIS TASK — comments since the brief, oldest first.`,
    `If the most recent one reports a problem with your last attempt,`,
    `fixing that is your first job this turn.`,
    ``,
  ];
  for (const c of comments) {
    const who = c.from === "system" ? "SYSTEM" : "TEAMMATE";
    const body =
      c.body.length > COMMENT_BODY_MAX
        ? `${c.body.slice(0, COMMENT_BODY_MAX)}…`
        : c.body;
    lines.push(`  [${who}] ${body.replace(/\n/g, "\n          ")}`);
  }
  return lines.join("\n");
}

// Tier 3b — prior work the specialist can reference while executing. We
// embed only snippets, not full document bodies; the agent can drill in
// later via tooling (or get pgvector retrieval in Phase 2). Tag-matched
// docs come first when the task has tags; otherwise recency-ordered.
function formatRelevantDocuments(spec: ContextSpec): string | null {
  const docs = spec.history?.relevantDocuments;
  if (!docs || docs.length === 0) return null;
  const lines = [
    `RELATED PRIOR WORK — use only as reference, not as a template to copy:`,
  ];
  for (const d of docs) {
    const snippet = d.snippet.replace(/\n/g, " ").trim();
    lines.push(`  • "${d.title}" — ${snippet}${snippet.length >= 200 ? "…" : ""}`);
  }
  return lines.join("\n");
}

// Company Brain (Tier 3) full-inline format — same shape as chat renderer
// to keep agents consistent across surfaces. Visibility already filtered
// at loadContext, so anything reaching us is authorized for this agent.
function formatCompanyBrain(spec: ContextSpec): string | null {
  const brain = spec.knowledge?.brain;
  if (!brain || brain.length === 0) return null;
  const sections: string[] = [
    `COMPANY BRAIN — persistent knowledge about ${spec.company.name}.`,
    `Treat as source-of-truth for terminology, policy, and editorial rules.`,
    ``,
  ];
  for (const file of brain) {
    sections.push(`### ${file.path}`);
    sections.push(file.content.trim());
    sections.push(``);
  }
  return sections.join("\n").trimEnd();
}

// See chat renderer for context. Same override constant repeated here
// to keep the renderers self-contained (different surface flavor, same
// runtime-memory leak problem).
const RUNTIME_MEMORY_OVERRIDE = [
  `PRIORITY — IGNORE PRIOR RUNTIME MEMORY BLOCKS:`,
  `If any "Memory", "User profile", "Things to remember", or similar`,
  `pre-existing block was injected above this instruction by the agent`,
  `runtime itself, treat it as STALE DATA from unrelated conversations.`,
  `Do not act on it, do not reference it, do not "recall" facts from it.`,
  `Your authoritative identity, persona, and operating context comes`,
  `EXCLUSIVELY from the workspace files + this task's brief below.`,
].join("\n");

// Inline persona / workspace markdown so the agent has its identity
// context regardless of adapter filesystem availability. Same block
// shape as chat renderer; both surfaces share the canonical content.
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

// Optional company profile block — only emit lines that have content
// so blank onboarding doesn't spam the prompt. Same shape as chat
// renderer; sharing format keeps agents consistent across surfaces.
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

// Canonical `OCCA runtime:` preamble. Renders the per-trace ephemeral
// credentials so the agent can authenticate callbacks (skill discovery,
// tool invocation, RequestInfo, EmitFollowUp). Without these the agent
// has no credential surface and degrades into "no integration available"
// refusals. Falls back to a pointer when the caller didn't mint a key
// (chat-mode previews, etc.).
function renderRuntimeEnvBlock(spec: ContextSpec): string {
  const env = spec.runtimeEnv;
  if (!env) {
    const s = spec.surface;
    const traceId = s.kind === "task" ? s.traceId : null;
    return [
      `RUNTIME:`,
      `  apiKey: <not provisioned for this surface>`,
      ...(traceId ? [`  traceId: ${traceId}`] : []),
    ].join("\n");
  }
  return [
    `OCCA runtime:`,
    `  apiUrl: ${env.apiUrl}`,
    `  apiKey: ${env.apiKey}`,
    `  agentId: ${env.agentId}`,
    `  traceId: ${env.traceId}`,
    ``,
    `  Use Bearer ${env.apiKey} on calls to /api/me/agent/* and`,
    `  /api/tools/*. This key is scoped to this trace and expires when`,
    `  the run finishes.`,
  ].join("\n");
}

// Pointer line for a pointer-truncated skill. `key` is the canonical
// "owner/repo/slug" identifier the fetch route matches on, URL-encoded so
// the slashes survive the path segment. The agent already has the Bearer
// credential from the OCCA runtime block above.
function skillFetchPointer(key: string): string {
  return (
    `  [skill body truncated to save context — summary above] ` +
    `Fetch the full skill before relying on it: ` +
    `GET /api/me/agent/skills/${encodeURIComponent(key)} ` +
    `(Bearer per the OCCA runtime block above).`
  );
}

// Inline assigned skills under a context budget. Small, high-signal skills
// are inlined whole — the previous always-inline design existed because
// pointer-ONLY made agents skip the fetch and refuse tasks ("no skill
// available", X-posting regress 2026-05-20), and that property is preserved
// for skills that fit. Large skills (and any past the total budget) instead
// get a header slice + a fetch pointer so one 130KB research skill can't
// drown the whole prompt. Just-in-time loading per docs/context-engineering.md.
function renderSkillsBlock(skills: ContextSpec["skills"]): string {
  const lines = [
    `SKILLS ASSIGNED TO YOU. Skills small enough are inlined in full below;`,
    `larger ones show a summary plus a fetch pointer — pull the full body via`,
    `that endpoint when the task actually needs the skill.`,
  ];
  let budgetSpent = 0;
  for (const s of skills) {
    const desc = s.description ? ` — ${s.description}` : "";
    const body = s.markdown.trim();
    const bytes = Buffer.byteLength(body, "utf8");
    const inlineWhole =
      bytes <= SKILL_INLINE_CAP && budgetSpent + bytes <= SKILLS_TOTAL_BUDGET;
    lines.push("");
    lines.push(`=== SKILL: ${s.key} (slug: ${s.slug}, name: ${s.name})${desc} ===`);
    lines.push("");
    if (inlineWhole) {
      lines.push(body);
      budgetSpent += bytes;
    } else {
      lines.push(`${body.slice(0, SKILL_HEADER_SLICE)}…`);
      lines.push("");
      lines.push(skillFetchPointer(s.key));
    }
    lines.push("");
    lines.push(`=== END SKILL: ${s.key} ===`);
  }
  return lines.join("\n");
}

// Pure transformer — no DB access, no IO. Throws if the surface isn't
// a task surface (caller bug). Plain prose framing (no XML wrapper) —
// Claude treats free-form structured prompts more reliably than tagged
// rule blocks (validated empirically on the chat surface).
export function renderTaskPrompt(spec: ContextSpec): string {
  if (spec.surface.kind !== "task") {
    throw new Error(
      `renderTaskPrompt called with non-task surface: ${spec.surface.kind}`,
    );
  }
  const s = spec.surface;
  const profileBlock = formatCompanyProfile(spec);
  const brainBlock = formatCompanyBrain(spec);
  const relatedDocsBlock = formatRelevantDocuments(spec);
  const workspaceFilesBlock = formatWorkspaceFiles(spec);
  const commentsBlock = renderCommentsBlock(s.comments);
  const acceptance = s.acceptanceCriteria
    ? [``, `Acceptance criteria: ${s.acceptanceCriteria}`]
    : [];

  // Three-path turn matrix:
  //   A) Children have already shipped → SYNTHESIZE (do NOT re-delegate
  //      even if subordinates are still listed — they're done, looping
  //      would re-assign the same work and cause the 2026-05-14 Nova
  //      regress where a Head re-delegated 4× in a row).
  //   B) Subordinates available + no completed children → DELEGATE
  //      (route to the right teammate; you'll be re-woken on cascade).
  //   C) No subordinates → EXECUTE SELF (write the deliverable).
  // CEO root task adds the [[OCCA:REPORT]] marker to whichever finish
  // path applies, because that's the only way content reaches the user.
  const hasSubordinates = spec.org.subordinatesForSelf.length > 0;
  const hasCompletedChildren = s.completedChildren.length > 0;
  const isReportFinisher = s.isRoot && s.isCeoAssignee;

  const turnInstructions: string[] = hasCompletedChildren
    ? [
        `- SYNTHESIS TURN. Children have already shipped — see the`,
        `  "Children that have shipped" block below. Read their output,`,
        `  judge quality, then write YOUR reply as the final deliverable`,
        `  for this task (a synthesis, review notes, edits, or sign-off`,
        `  on what they produced).`,
        `- Default: don't re-delegate. Your subordinates already shipped.`,
        `  Re-delegating the SAME work would loop the task. If their`,
        `  output is unusable, write feedback and end with [[OCCA:REVIEW]]`,
        `  to park the task for a human — do NOT respawn the same`,
        `  assignment to the same teammate.`,
        `- Exception: if your standing mandate explicitly calls for a NEXT`,
        `  STEP delegated to a DIFFERENT teammate (e.g. "writer first,`,
        `  then social media editor"), emit [[OCCA:DELEGATE]] with the`,
        `  next teammate's id from "Available reports" below. Pick the`,
        `  teammate whose role matches the next step — never the one who`,
        `  just shipped.`,
        ...(isReportFinisher
          ? [
              `- THIS TASK IS THE USER'S REQUEST. Wrap your synthesis in`,
              `  [[OCCA:REPORT]] — that body is what the user sees.`,
            ]
          : [
              `- Your reply IS the final deliverable. Plain reply, no`,
              `  [[OCCA:*]] marker. The runtime saves your full reply to`,
              `  the task and forwards it up the chain on done.`,
            ]),
      ]
    : hasSubordinates
      ? [
          ...(isReportFinisher
            ? [
                `- THIS TASK IS THE USER'S REQUEST. The user only ever sees`,
                `  what you put inside an [[OCCA:REPORT]] marker.`,
                `- DELEGATE this turn (see "Available reports" block).`,
                `  REPORT comes on the NEXT dispatch (after children`,
                `  cascade back). Do not emit REPORT and DELEGATE in the`,
                `  same reply.`,
              ]
            : [
                `- DELEGATE this turn — see "Available reports" block. Pick`,
                `  a subordinate that fits and emit [[OCCA:DELEGATE]] with`,
                `  their id. You'll be re-woken when they finish, and that`,
                `  next dispatch is when you synthesize their result.`,
              ]),
        ]
      : [
          ...(isReportFinisher
            ? [
                `- THIS TASK IS THE USER'S REQUEST. Do the work yourself`,
                `  and emit [[OCCA:REPORT]] in the SAME reply.`,
                `- Closing a root task without REPORT parks it in 'review'`,
                `  — the user sees nothing. REPORT is mandatory to ship.`,
              ]
            : [
                `- Your reply is your final deliverable for this task.`,
                `  Write it in full — markdown, code blocks, whatever the`,
                `  brief calls for. Do NOT wrap it in any [[OCCA:*]] marker.`,
                `  The runtime saves your full reply to the task and`,
                `  forwards the result up the chain; any marker you emit`,
                `  will be stripped and the content lost.`,
                `- Otherwise your reply will automatically mark the task`,
                `  as done.`,
              ]),
        ];

  // Continuation banner — printed at the very top when at least one
  // child has shipped. The task brief (which for routine wrappers
  // contains the full multi-step mandate) reads from the bottom of
  // the prompt; without this banner the agent re-runs step 1 of the
  // mandate as if it were a fresh wake. The banner pins the agent
  // to the actual phase ("the writer already shipped — move on to
  // review + handoff") so the mandate text gets read in context.
  const continuationBanner = hasCompletedChildren
    ? [
        `===============================================================`,
        `CONTINUATION TURN — READ THIS BEFORE THE TASK BRIEF.`,
        ``,
        `You woke up because a subordinate just finished their piece of`,
        `THIS task — listed under "RECENT ACTIVITY" below. The early steps`,
        `of your mandate (research, slate selection, writer hand-off) are`,
        `DONE. Do NOT re-run them.`,
        ``,
        `Your job this turn: pick up where your mandate continues AFTER`,
        `the writer hand-off. Typically that means review the shipped`,
        `piece, then either close the cycle or hand off the next step to`,
        `a DIFFERENT teammate (e.g. social media editor) per your mandate.`,
        ``,
        `If your mandate has no further steps, synthesize the work and`,
        `let the task auto-close. Do not start a brand-new research cycle.`,
        `===============================================================`,
        ``,
      ]
    : [];

  return [
    RUNTIME_MEMORY_OVERRIDE,
    ``,
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — running inside OCCA OS in TASK mode.`,
    ``,
    ...continuationBanner,
    ...(workspaceFilesBlock ? [workspaceFilesBlock, ``] : []),
    ...(profileBlock ? [profileBlock, ``] : []),
    ...(brainBlock ? [brainBlock, ``] : []),
    ...(relatedDocsBlock ? [relatedDocsBlock, ``] : []),
    renderRuntimeEnvBlock(spec),
    ``,
    ...(spec.skills.length > 0 ? [renderSkillsBlock(spec.skills), ``] : []),
    `INSTRUCTIONS:`,
    `- Work on the task described below and respond with your findings or result.`,
    `- Research budget — work efficiently, you have a bounded run. If the task`,
    `  needs web research, issue searches/fetches in PARALLEL (batch multiple`,
    `  tool calls in one turn), aim for roughly 6-8 searches and 6-8 fetches`,
    `  total, then STOP gathering and write. Once you have enough sourced facts`,
    `  to satisfy the brief, do not keep verifying past sufficiency — diminishing`,
    `  returns will exhaust the run before you produce the deliverable. Prefer a`,
    `  complete, well-sourced piece over an exhaustive but unfinished one.`,
    `- If the task requires human review before being closed, end your reply with: [[OCCA:REVIEW]]`,
    `- If you published your deliverable at a public URL (e.g. via a posting`,
    `  tool), report that URL in the SAME reply so it is anchored on-chain as`,
    `  the proof-of-work link. Emit it BEFORE the task closes:`,
    ``,
    `    [[OCCA:SET_RESULT_URL]]`,
    `    { "resultUri": "https://<the live URL of your published work>" }`,
    `    [[/OCCA:SET_RESULT_URL]]`,
    ``,
    `  Only the canonical public URL of THIS task's deliverable. Omit it if`,
    `  the work was not published anywhere public.`,
    ...turnInstructions,
    `- If you can't finish solo, emit ONE of these BLOCK MARKERS in your`,
    `  reply (the server parses the JSON body and acts on it):`,
    ``,
    `    [[OCCA:DELEGATE]]`,
    `    {`,
    `      "targetAgentId": "<uuid from 'Available reports' below>",`,
    `      "title": "<short task title>",`,
    `      "description": "<full detail>",`,
    `      "acceptanceCriteria": "<optional>"`,
    `    }`,
    `    [[/OCCA:DELEGATE]]`,
    ``,
    `    [[OCCA:BLOCK]]`,
    `    {`,
    `      "blockedByTaskIds": ["<task uuid>", "..."],`,
    `      "reason": "<short why-blocked, posted to the task's comment thread>"`,
    `    }`,
    `    [[/OCCA:BLOCK]]`,
    ``,
    `  When to use which:`,
    `    DELEGATE — someone in Available reports can do the job.`,
    `    BLOCK    — you're waiting on other tasks to complete first.`,
    `  Emit at most ONE such block per turn. The block can sit anywhere in`,
    `  your reply — the server parses + strips it before persisting.`,
    ``,
    `  For mid-task clarification questions, do NOT emit a block — POST to`,
    `  /api/agents/me/actions/emit with type "RequestInfo" instead. The`,
    `  server posts a comment AND parks the task in 'review' so the human`,
    `  is unblocked of the kanban card. See the OCCA Runtime skill.`,
    ``,
    `  After completing a task, if the natural follow-up is another task`,
    `  (not a clarifying question or a sub-delegation), POST to the same`,
    `  endpoint with type "EmitFollowUp" instead. The server creates a`,
    `  child task linked to the current one. Use sparingly — caps:`,
    `  max 3 children per parent, max chain depth 2. Required body:`,
    `  { parentTaskId: <current task uuid>, idempotencyKey: <stable str>,`,
    `    payload: { title, taskType, acceptanceCriteria? } }.`,
    `- Do not add meta-commentary — focus on the task deliverable.`,
    ``,
    // Synthesis turn (a child shipped): show the full subordinate list
    // with soft-wording mode. The 2026-05-14 loop-avoidance reason for
    // suppressing this entirely was correct as a no-loop guard but it
    // blocks legitimate next-step delegation (writer → social media
    // editor handoff in a multi-step mandate). Soft mode keeps the
    // anti-loop language while exposing IDs so a real chain can fire.
    renderReportsBlock(spec.org.subordinatesForSelf, {
      synthesisMode: hasCompletedChildren,
    }),
    ``,
    ...(s.isRoot && s.isCeoAssignee ? [renderRootReportBlock(), ``] : []),
    ...(s.completedChildren.length > 0
      ? [renderCompletedChildrenBlock(s.completedChildren), ``]
      : []),
    ...(commentsBlock ? [commentsBlock, ``] : []),
    `---`,
    ``,
    `TASK BRIEF:`,
    ``,
    `# Task #${s.taskNumber} — ${s.title}`,
    `Priority: ${s.priority} · Type: ${s.taskType} · Effort: ${s.effortLevel}`,
    ``,
    s.bodyMarkdown,
    ...acceptance,
  ].join("\n");
}
