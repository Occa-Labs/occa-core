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
import { db } from "../../infra/database/client";
import {
  renderReportsBlock,
  renderRootReportBlock,
} from "../delegation/policy";
import type { ContextSpec, SurfacePayload } from "./spec";

// Max chars per completed-child preview surfaced to the parent agent.
// Sized for ~1-2 short pages of prose — long enough for a CEO to
// synthesize a Writer's draft, short enough to keep total prompt cost
// bounded when 4-5 specialists report in. Truncation is suffixed "…"
// so the agent knows the snippet was clipped.
const CHILD_RESULT_PREVIEW_MAX = 4_000;

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
        `- DO NOT re-delegate this turn. Your subordinates already`,
        `  completed the work. Re-delegating would loop the task and`,
        `  duplicate the assignment. If their output is unusable, write`,
        `  feedback in your reply and end with [[OCCA:REVIEW]] so a human`,
        `  decides next steps — but do NOT spawn another DELEGATE.`,
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

  return [
    `You are ${spec.agent.name}, the ${spec.agent.roleLabel} of ${spec.company.name} — running inside OCCA OS in TASK mode.`,
    ``,
    `Your full persona lives in your workspace files (./SOUL.md, ./AGENTS.md, ./IDENTITY.md, ./HEARTBEAT.md). Read them if you haven't this session.`,
    ``,
    ...(profileBlock ? [profileBlock, ``] : []),
    ...(brainBlock ? [brainBlock, ``] : []),
    ...(relatedDocsBlock ? [relatedDocsBlock, ``] : []),
    `RUNTIME:`,
    `  Trace ID: ${s.traceId}`,
    `  API base: ${s.gatewayUrl ?? "unknown"}`,
    ``,
    `INSTRUCTIONS:`,
    `- Work on the task described below and respond with your findings or result.`,
    `- If the task requires human review before being closed, end your reply with: [[OCCA:REVIEW]]`,
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
    // Pass empty array when children have already shipped — synthesis
    // turn must not contain "DELEGATION IS MANDATORY" language, which
    // would contradict the turn instructions above and produce the
    // re-delegation loop.
    renderReportsBlock(
      hasCompletedChildren ? [] : spec.org.subordinatesForSelf,
    ),
    ``,
    ...(s.isRoot && s.isCeoAssignee ? [renderRootReportBlock(), ``] : []),
    ...(s.completedChildren.length > 0
      ? [renderCompletedChildrenBlock(s.completedChildren), ``]
      : []),
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
