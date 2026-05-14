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
  handleBlockBlock,
  handleDelegateBlock,
  handleReportBlock,
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
      return handleDelegateBlock(args, deps);
    case "BLOCK":
      return handleBlockBlock(args);
    case "REPORT":
      return handleReportBlock(args);
    default:
      log.warn({ token }, "unknown action-block token, ignored");
      return { kind: "ignored", reason: "unknown_token" };
  }
}
