// Parser + dispatcher for OCCA block markers found in an agent reply.
// Lifts `[[OCCA:DELEGATE]]` etc. out of free text via @occa/shared/markers,
// then routes each block to its per-token handler. The dispatcher
// service threads `ActionBlockDeps` through so handlers stay free of
// cross-feature imports.

import { extractActionBlocks } from "@occa/shared/markers";
import { childLogger } from "../../../lib/logger";
import {
  type ActionBlockOutcome,
} from "./schemas";
import {
  handleAssignRoutineBlock,
  handleBindToolBlock,
  handleBlockBlock,
  handleDelegateBlock,
  handleDispatchRoutineBlock,
  handleGateVerdictBlock,
  handleInstallSkillBlock,
  handleProposeDeploymentBlock,
  handleReportBlock,
  handleSetResultUrlBlock,
  handleToggleChannelBlock,
  handleToggleRoutineBlock,
  handleToggleWorkflowBlock,
  handleUnbindToolBlock,
  handleUninstallSkillBlock,
  type ActionBlockDeps,
  type ActionBlockHandlerArgs,
} from "./handlers";

const log = childLogger("services:delegation:markers:parser");

export interface ProcessedActionBlock {
  token: string;
  body: Record<string, unknown> | null;
  outcome: ActionBlockOutcome;
}

export interface ProcessActionBlocksArgs {
  reply: string;
  agentId: string;
  agentRole: string;
  companyId: string;
  currentTaskId: string;
  traceId: string;
  // Set when the emitting task is a workflow step — suppresses DELEGATE so the
  // engine stays the sole spawner of step tasks (see ActionBlockHandlerArgs).
  isWorkflowStep?: boolean;
}

export async function processActionBlocks(
  args: ProcessActionBlocksArgs,
  deps: ActionBlockDeps,
): Promise<ProcessedActionBlock[]> {
  const blocks = extractActionBlocks(args.reply);
  log.info(
    {
      taskId: args.currentTaskId,
      agentId: args.agentId,
      blockCount: blocks.length,
      tokens: blocks.map((b) => b.token),
    },
    "action blocks extracted from reply",
  );
  const results: ProcessedActionBlock[] = [];
  for (const block of blocks) {
    // Tokens that require JSON bodies (DELEGATE, BLOCK) validate via
    // their per-handler zod schema below — `block.body` will be null
    // when JSON parse failed, and the schema's safeParse returns
    // `ignored:invalid_payload` cleanly. Tokens with plain-text bodies
    // (REPORT) read `block.raw` directly. Either way the parser
    // no longer short-circuits on invalid JSON.
    const handlerArgs: ActionBlockHandlerArgs = {
      block,
      agentId: args.agentId,
      agentRole: args.agentRole,
      companyId: args.companyId,
      currentTaskId: args.currentTaskId,
      traceId: args.traceId,
      isWorkflowStep: args.isWorkflowStep,
    };
    try {
      const outcome = await routeBlock(block.token, handlerArgs, deps);
      log.info(
        {
          taskId: args.currentTaskId,
          token: block.token,
          outcomeKind: outcome.kind,
        },
        "action block handled",
      );
      results.push({ token: block.token, body: block.body, outcome });
    } catch (err) {
      log.error(
        { err, token: block.token, taskId: args.currentTaskId },
        "action block handler threw",
      );
      results.push({
        token: block.token,
        body: block.body,
        outcome: { kind: "ignored", reason: "handler_threw" },
      });
    }
  }
  return results;
}

async function routeBlock(
  token: string,
  args: ActionBlockHandlerArgs,
  deps: ActionBlockDeps,
): Promise<ActionBlockOutcome> {
  switch (token) {
    case "DELEGATE":
      // Workflow steps don't spawn their own children — the engine drives the
      // pipeline (e.g. a gate fail re-spawns the draft via on_fail_goto). A
      // step agent's DELEGATE would duplicate that, so drop it. Recorded as an
      // ignored outcome (audit), not acted on.
      if (args.isWorkflowStep) {
        log.warn(
          { taskId: args.currentTaskId, agentId: args.agentId },
          "DELEGATE from a workflow step ignored — engine owns step spawning",
        );
        return { kind: "ignored", reason: "workflow_step_no_delegate" };
      }
      return handleDelegateBlock(args, deps);
    case "BLOCK":
      return handleBlockBlock(args);
    case "GATE_VERDICT":
      return handleGateVerdictBlock(args);
    case "REPORT":
      return handleReportBlock(args);
    case "SET_RESULT_URL":
      return handleSetResultUrlBlock(args);
    case "INSTALL_SKILL":
      return handleInstallSkillBlock(args);
    case "UNINSTALL_SKILL":
      return handleUninstallSkillBlock(args);
    case "BIND_TOOL":
      return handleBindToolBlock(args);
    case "UNBIND_TOOL":
      return handleUnbindToolBlock(args);
    case "TOGGLE_CHANNEL":
      return handleToggleChannelBlock(args);
    case "TOGGLE_WORKFLOW":
      return handleToggleWorkflowBlock(args);
    case "TOGGLE_ROUTINE":
      return handleToggleRoutineBlock(args);
    case "DISPATCH_ROUTINE":
      return handleDispatchRoutineBlock(args);
    case "ASSIGN_ROUTINE":
      return handleAssignRoutineBlock(args);
    case "PROPOSE_DEPLOYMENT":
      return handleProposeDeploymentBlock(args);
    default:
      log.warn({ token }, "unknown action-block token, ignored");
      return { kind: "ignored", reason: "unknown_token" };
  }
}
