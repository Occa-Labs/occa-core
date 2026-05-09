// Builds the agent-facing prompt for a task dispatch. Renders:
//   - Runtime preamble (agent identity, trace id, task header)
//   - Block-marker reference (DELEGATE / BLOCK / REVIEW)
//   - Available reports
//   - Recent activity (children that completed since last dispatch)
//   - The task body itself (markdown'd from ContentBlock[])
//
// `listSubordinates` is a cross-feature primitive (features/agents) so
// it's accepted as an injected dep — same pattern as action-block
// handlers' `canDeploy`.

import { and, eq, inArray } from "drizzle-orm";
import { agentIdentities, deployments, tasks } from "@occa/shared/schema";
import type { ContentBlock } from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export interface AgentContextForPrompt {
  id: string;
  companyId: string;
  role: string;
  name: string;
  adapterType: string;
  adapterConfig: unknown;
  externalAgentId: string | null;
}

export interface SubordinateRef {
  id: string;
  name: string;
  role: string;
}

export interface PromptBuilderDeps {
  // Cross-feature port: returns the deployment's direct reports for the
  // DELEGATE block hint. Wired in from features/agents/services/
  // deployment-hierarchy.listSubordinates.
  listSubordinates: (deploymentId: string) => Promise<SubordinateRef[]>;
}

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

function renderReportsBlock(reports: SubordinateRef[]): string {
  if (reports.length === 0) {
    return [
      `Available reports (DELEGATE): none.`,
      `You have no agents reporting to you yet. If the task needs another`,
      `role, finish what you can and flag the gap to the human in your reply.`,
    ].join("\n");
  }
  const lines = [
    `Available reports (DELEGATE — assign work to an existing teammate):`,
  ];
  for (const r of reports) {
    lines.push(`  - ${r.name} (role: ${r.role}, id: ${r.id})`);
  }
  return lines.join("\n");
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

function renderCompletedChildrenBlock(children: CompletedChildRef[]): string {
  if (children.length === 0) return "";
  const lines = [
    `RECENT ACTIVITY — child tasks that completed since you last looked:`,
    ``,
  ];
  for (const c of children) {
    const who = c.agentName ?? "agent";
    lines.push(`  • Task #${c.taskNumber} "${c.title}" — completed by ${who}`);
    if (c.resultPreview) {
      const trimmed = c.resultPreview.slice(0, 280).replace(/\n/g, " ");
      lines.push(
        `      result: ${trimmed}${c.resultPreview.length > 280 ? "…" : ""}`,
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

export async function buildTaskPrompt(
  task: typeof tasks.$inferSelect,
  agent: AgentContextForPrompt,
  traceId: string,
  deps: PromptBuilderDeps,
): Promise<string> {
  const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const body = blocksToMarkdown((task.blocks ?? []) as ContentBlock[]);
  const reports = await deps.listSubordinates(agent.id);
  const completedChildren = await loadCompletedChildren(task.id);
  const acceptance = task.acceptanceCriteria
    ? [``, `Acceptance criteria: ${task.acceptanceCriteria}`]
    : [];

  return [
    `<occa-runtime>`,
    `You are running inside OCCA OS as agent "${agent.name}" (role: ${agent.role}).`,
    `Trace ID: ${traceId}`,
    `Task #${task.taskNumber} — "${task.title}"`,
    `Priority: ${task.priority} · Type: ${task.taskType} · Effort: ${task.effortLevel}`,
    ``,
    `INSTRUCTIONS:`,
    `- Work on the task described below and respond with your findings or result.`,
    `- If the task requires human review before being closed, end your reply with: [[OCCA:REVIEW]]`,
    `- Otherwise your reply will automatically mark the task as done.`,
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
    renderReportsBlock(reports),
    ``,
    ...(completedChildren.length > 0
      ? [renderCompletedChildrenBlock(completedChildren), ``]
      : []),
    `API base: ${typeof cfg.gatewayUrl === "string" ? cfg.gatewayUrl : "unknown"}`,
    `</occa-runtime>`,
    ``,
    `<task>`,
    `# ${task.title}`,
    body,
    ...acceptance,
    `</task>`,
  ].join("\n");
}
