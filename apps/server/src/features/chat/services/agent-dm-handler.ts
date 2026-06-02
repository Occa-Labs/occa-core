// Phase C handler: process one turn in an agent_dm thread.
//
// An agent_dm thread is a directive surface opened when a caller agent
// emits DELEGATE to a non-leaf target (Head). The caller's directive is
// posted as a `role: 'user'` message in the thread; this handler picks
// it up, runs the callee through chat-mode, parses the reply, and:
//   • [[OCCA:DELEGATE]] target=leaf      → createTaskRecord (1 task)
//   • [[OCCA:DELEGATE]] target=non-leaf  → openAgentDmThread (recursive)
//   • [[OCCA:CREATE_TASK]]               → task assigned to callee (self-execute)
//
// The recursion is what gives Phase C its auto-scale property: any tier
// can route via DELEGATE without needing a task wrapper of its own. The
// only ground truth that produces a board-visible task is "DELEGATE to a
// leaf" or "CREATE_TASK".

import { asc, eq } from "drizzle-orm";
import {
  agentIdentities,
  chatMessages,
  chatThreads,
  deployments,
  traces,
} from "@occa/shared/schema";
import { extractActionBlocks, stripOccaMarkers } from "@occa/shared/markers";
import { getTier, roleLabelFor } from "@occa/shared/role-catalog";
import { childLogger } from "../../../lib/logger";
import { db } from "../../../infra/database/client";
import { getAdapter } from "../../../lib/adapter-registry";
import { AGENT_WAIT_TIMEOUT_MS } from "../../../lib/timing";
import { threadSessionKey } from "../../../lib/session-keys";
import { findByDeploymentId as findRuntimeProfile } from "../../agents/repositories/agent-runtime-profile";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";
import { insertMessage } from "../repositories/chat-messages";
import { openAgentDmThread } from "../repositories/chat-threads";
import { delegateBlockPayload } from "../../../services/delegation/markers/schemas";
import {
  loadContext,
  renderChatPrompt,
  ContextNotFoundError,
} from "../../../services/memory";

const log = childLogger("services:agent-dm-handler");

export type AgentDmTurnResult =
  | { kind: "ok" }
  | { kind: "thread_not_found" }
  | { kind: "callee_not_configured"; reason: string }
  | { kind: "no_directive" }
  | { kind: "adapter_failed"; reason: string };

interface DelegateBodyParsed {
  targetAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string | null;
  priority?: string | null;
  tags?: string[] | null;
}

function readDelegateBody(
  body: Record<string, unknown> | null,
): DelegateBodyParsed | null {
  if (!body) return null;
  const parsed = delegateBlockPayload.safeParse(body);
  if (!parsed.success) return null;
  return {
    targetAgentId: parsed.data.targetAgentId,
    title: parsed.data.title,
    description: parsed.data.description,
    acceptanceCriteria: parsed.data.acceptanceCriteria ?? null,
    priority: null,
    tags: null,
  };
}

interface CreateTaskBody {
  title: string;
  brief: string;
  tags?: string[];
  priority?: string;
}

function readCreateTaskBody(
  body: Record<string, unknown> | null,
): CreateTaskBody | null {
  if (!body) return null;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (title.length === 0 || brief.length === 0) return null;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const priority =
    typeof body.priority === "string" ? body.priority.trim() : undefined;
  return { title, brief, tags, priority };
}

// Resolves a human-readable name + role label for the caller deployment.
// Falls back to role label / "Unknown caller" when records are missing.
async function resolveCallerIdentity(
  callerDeploymentId: string | null,
): Promise<{ name: string; role: string }> {
  if (!callerDeploymentId) {
    return { name: "System", role: "automation" };
  }
  const [row] = await db
    .select({
      role: deployments.role,
      identityName: agentIdentities.name,
    })
    .from(deployments)
    .leftJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(eq(deployments.id, callerDeploymentId))
    .limit(1);
  if (!row) {
    return { name: "Unknown caller", role: "unknown" };
  }
  const name = row.identityName ?? roleLabelFor(row.role);
  return { name, role: roleLabelFor(row.role) };
}

export async function processAgentDmTurn(
  threadId: string,
): Promise<AgentDmTurnResult> {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread || thread.kind !== "agent_dm") {
    return { kind: "thread_not_found" };
  }

  const [callee] = await db
    .select({
      id: deployments.id,
      companyId: deployments.companyId,
      role: deployments.role,
      status: deployments.status,
    })
    .from(deployments)
    .where(eq(deployments.id, thread.deploymentId))
    .limit(1);
  if (!callee) {
    return { kind: "callee_not_configured", reason: "deployment_missing" };
  }
  if (callee.status !== "active") {
    return { kind: "callee_not_configured", reason: "deployment_inactive" };
  }

  const profile = await findRuntimeProfile(callee.id);
  if (!profile) {
    return { kind: "callee_not_configured", reason: "runtime_profile_missing" };
  }
  if (!profile.externalAgentId) {
    return { kind: "callee_not_configured", reason: "not_provisioned" };
  }
  const adapter = getAdapter(profile.adapterType);
  if (!adapter) {
    return { kind: "callee_not_configured", reason: "unknown_adapter" };
  }

  const history = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));

  const latestDirective = [...history]
    .reverse()
    .find((m) => m.role === "user");
  if (!latestDirective) {
    log.warn({ threadId }, "no user/directive message in agent_dm thread");
    return { kind: "no_directive" };
  }

  // isFirstTurn = no prior assistant reply in this thread. Drives the
  // adapter sessionKey suffix + whether we send the heavy preamble.
  const isFirstTurn = !history.some((m) => m.role === "assistant");

  const caller = await resolveCallerIdentity(thread.callerDeploymentId);

  let wakePrompt = latestDirective.content;
  try {
    const spec = await loadContext({
      deploymentId: callee.id,
      surface: {
        kind: "agent_dm",
        isFirstTurn,
        directive: latestDirective.content,
        callerName: caller.name,
        callerRole: caller.role,
      },
    });
    wakePrompt = renderChatPrompt(spec);
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      log.warn(
        { threadId, calleeId: callee.id },
        "loadContext returned no deployment — sending raw directive",
      );
    } else {
      log.error({ err, threadId }, "loadContext failed");
    }
  }

  const startedAt = new Date();
  const [traceRow] = await db
    .insert(traces)
    .values({
      companyId: callee.companyId!,
      deploymentId: callee.id,
      invocationSource: "chat",
      conversationId: `agent-dm-${threadId}`,
      actorType: thread.callerDeploymentId ? "deployment" : "system",
      actorId: thread.callerDeploymentId ?? null,
      status: "running",
      startedAt,
    })
    .returning({ id: traces.id });
  const traceId = traceRow.id;

  const cfg = (profile.adapterConfig ?? {}) as Record<string, unknown>;
  // One gateway session per thread — shared with synthesis (see
  // `lib/session-keys`). The old `:dm:` key diverged from synthesis's
  // `:thread:` key, splitting the conversation memory.
  const sessionKey = threadSessionKey(
    profile.externalAgentId,
    threadId,
    thread.resetGeneration,
  );
  const result = await adapter.sendPrompt({
    adapterConfig: cfg,
    externalAgentId: profile.externalAgentId,
    sessionKey,
    message: wakePrompt,
    waitTimeoutMs: AGENT_WAIT_TIMEOUT_MS,
  });
  const finishedAt = new Date();

  if (!result.ok) {
    await db
      .update(traces)
      .set({
        status: "failed",
        finishedAt,
        error: result.reason ?? result.error,
        errorCode: result.error,
        updatedAt: finishedAt,
      })
      .where(eq(traces.id, traceId));
    log.warn(
      { threadId, error: result.error, reason: result.reason },
      "agent_dm adapter call failed",
    );
    return { kind: "adapter_failed", reason: result.reason ?? result.error };
  }

  const blocks = extractActionBlocks(result.reply);
  const delegateBlock = blocks.find(
    (b) => b.token === "DELEGATE" && b.parsed,
  );
  const createBlock = blocks.find(
    (b) => b.token === "CREATE_TASK" && b.parsed,
  );

  let createdTaskId: string | null = null;

  if (delegateBlock) {
    const dp = readDelegateBody(delegateBlock.body);
    if (dp) {
      const [target] = await db
        .select({
          id: deployments.id,
          companyId: deployments.companyId,
          status: deployments.status,
          role: deployments.role,
        })
        .from(deployments)
        .where(eq(deployments.id, dp.targetAgentId))
        .limit(1);
      if (
        !target ||
        target.companyId !== callee.companyId ||
        target.status !== "active"
      ) {
        log.warn(
          { threadId, targetAgentId: dp.targetAgentId },
          "agent_dm DELEGATE ignored: target not in company or not active",
        );
      } else if (target.id === callee.id) {
        log.warn(
          { threadId, calleeId: callee.id },
          "agent_dm DELEGATE ignored: target is the callee itself (use CREATE_TASK)",
        );
      } else if (getTier(target.role) === "head") {
        // Recursive: open another agent_dm thread one tier down.
        const opened = await openAgentDmThread({
          companyId: callee.companyId!,
          callerDeploymentId: callee.id,
          calleeDeploymentId: target.id,
          parentThreadId: threadId,
          directive: {
            title: dp.title,
            body: dp.description,
            acceptanceCriteria: dp.acceptanceCriteria,
            priority: dp.priority,
            tags: dp.tags,
          },
        });
        log.info(
          {
            threadId,
            calleeDeploymentId: target.id,
            dmThreadId: opened.threadId,
          },
          "agent_dm DELEGATE → child agent_dm thread opened",
        );
      } else {
        // Leaf target: open a head↔specialist dm thread for observability
        // (autoDispatch=false — the specialist runs via task) then spawn
        // the task with originatingThreadId pointing at the new dm thread
        // so cascade bubbles the synthesised result there first, then
        // recurses up via parentThreadId.
        const opened = await openAgentDmThread({
          companyId: callee.companyId!,
          callerDeploymentId: callee.id,
          calleeDeploymentId: target.id,
          parentThreadId: threadId,
          directive: {
            title: dp.title,
            body: dp.description,
            acceptanceCriteria: dp.acceptanceCriteria,
            priority: dp.priority,
            tags: dp.tags,
          },
          autoDispatch: false,
        });
        const taskRow = await createTaskRecord({
          companyId: callee.companyId!,
          title: dp.title,
          blocks: [{ type: "paragraph", text: dp.description }],
          status: "todo",
          priority: dp.priority ?? "medium",
          taskType: "other",
          effortLevel: "m",
          tags: dp.tags ?? [],
          dueDate: null,
          assignedDeploymentId: dp.targetAgentId,
          parentTaskId: null,
          createdByUserId: null,
          createdByDeploymentId: callee.id,
          acceptanceCriteria: dp.acceptanceCriteria ?? null,
          originatingThreadId: opened.threadId,
        });
        createdTaskId = taskRow.id;
        enqueueTaskDispatch(taskRow.id).catch((err) =>
          log.error(
            { err, taskId: taskRow.id },
            "agent_dm DELEGATE: enqueueTaskDispatch failed",
          ),
        );
      }
    } else {
      log.warn({ threadId }, "agent_dm DELEGATE ignored: invalid payload");
    }
  } else if (createBlock) {
    const cb = readCreateTaskBody(createBlock.body);
    if (cb) {
      const taskRow = await createTaskRecord({
        companyId: callee.companyId!,
        title: cb.title,
        blocks: [{ type: "paragraph", text: cb.brief }],
        status: "todo",
        priority: cb.priority ?? "medium",
        taskType: "other",
        effortLevel: "m",
        tags: cb.tags ?? [],
        dueDate: null,
        assignedDeploymentId: callee.id,
        parentTaskId: null,
        createdByUserId: null,
        createdByDeploymentId: callee.id,
        acceptanceCriteria: null,
        originatingThreadId: threadId,
      });
      createdTaskId = taskRow.id;
      enqueueTaskDispatch(taskRow.id).catch((err) =>
        log.error(
          { err, taskId: taskRow.id },
          "agent_dm CREATE_TASK: enqueueTaskDispatch failed",
        ),
      );
    }
  }

  const cleanReply = stripOccaMarkers(result.reply);
  await insertMessage({
    threadId,
    companyId: callee.companyId!,
    deploymentId: callee.id,
    role: "assistant",
    content: cleanReply.length > 0 ? cleanReply : "(empty reply)",
    createdTaskId,
    traceId,
  });

  await db
    .update(traces)
    .set({
      status: "succeeded",
      finishedAt,
      updatedAt: finishedAt,
      resultJson: { text: result.reply },
    })
    .where(eq(traces.id, traceId));

  return { kind: "ok" };
}
