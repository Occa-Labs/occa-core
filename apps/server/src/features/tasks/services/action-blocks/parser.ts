// Parser + dispatcher for OCCA block markers found in an agent reply.
// Lifts `[[OCCA:DELEGATE]]` etc. out of free text via @occa/shared/markers,
// then routes each block to its per-token handler. The dispatcher
// service threads `ActionBlockDeps` through so handlers stay free of
// cross-feature imports.

import { extractActionBlocks } from "@occa/shared/markers";
import { childLogger } from "../../../../lib/logger";
import {
  type ActionBlockOutcome,
} from "../../domain/action-blocks/schemas";
import {
  handleBlockBlock,
  handleDelegateBlock,
  type ActionBlockDeps,
  type ActionBlockHandlerArgs,
} from "./handlers";

const log = childLogger("services:tasks:action-blocks:parser");

export interface ProcessedActionBlock {
  token: string;
  body: Record<string, unknown> | null;
  outcome: ActionBlockOutcome;
}

export interface ProcessActionBlocksArgs {
  reply: string;
  agentId: string;
  companyId: string;
  currentTaskId: string;
}

export async function processActionBlocks(
  args: ProcessActionBlocksArgs,
  deps: ActionBlockDeps,
): Promise<ProcessedActionBlock[]> {
  const blocks = extractActionBlocks(args.reply);
  const results: ProcessedActionBlock[] = [];
  for (const block of blocks) {
    if (!block.parsed || !block.body) {
      log.warn({ token: block.token }, "action block had invalid JSON, ignored");
      results.push({
        token: block.token,
        body: null,
        outcome: { kind: "ignored", reason: "invalid_json" },
      });
      continue;
    }
    const handlerArgs: ActionBlockHandlerArgs = {
      block,
      agentId: args.agentId,
      companyId: args.companyId,
      currentTaskId: args.currentTaskId,
    };
    try {
      const outcome = await routeBlock(block.token, handlerArgs, deps);
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
      return handleDelegateBlock(args, deps);
    case "BLOCK":
      return handleBlockBlock(args);
    default:
      log.warn({ token }, "unknown action-block token, ignored");
      return { kind: "ignored", reason: "unknown_token" };
  }
}
