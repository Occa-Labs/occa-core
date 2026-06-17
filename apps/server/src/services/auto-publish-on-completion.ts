// Auto-publish bridge. When a task settles into `done`, if the company has
// an active Publish tool whose role gate the completing agent passes, the
// deliverable is shipped through that tool server-side — deterministically,
// with no agent action required. The receiver's returned public URL becomes
// the task's result_uri, which then anchors on-chain as proof-of-work.
//
// This is the "agent on rails" form of publishing: the lifecycle guarantees
// it, the agent doesn't have to remember to call a tool. Install the Publish
// tool → deliverables publish + anchor automatically. Don't install it →
// nothing publishes (the deliverable stays private, hash-only). Generic and
// company-agnostic: the receiver maps role → destination, OCCA does not.
//
// Lives in services/ (legacy spine) because it bridges features/tasks
// (finalize) and features/tools (invokeTool) — CLAUDE.md forbids
// feature-to-feature imports. Mirrors deliver-task-webhooks.ts.

import type { AgentRole } from "@occa/shared/types";
import { childLogger } from "../lib/logger";
import { listForCompany } from "../features/tools/repositories/company-tools";
import { invokeTool } from "../features/tools/services/invoke";

const log = childLogger("services:auto-publish-on-completion");

// The embedded handler `type` that ships a deliverable and returns its
// public URL. Matches handlers/publish.ts.
const PUBLISH_TOOL_TYPE = "publish";
const PUBLISH_ACTION = "post";

export interface AutoPublishInput {
  companyId: string;
  /** The completing agent's deployment — drives role-based receiver routing. */
  deploymentId: string;
  agentRole: string;
  document: { title: string; content: string; tags: string[] };
}

export interface AutoPublishResult {
  /** The receiver's public URL, or null when nothing published (no active
   *  tool, role gated out, or the receiver returned no URL). */
  resultUri: string | null;
}

export async function autoPublishOnCompletion(
  input: AutoPublishInput,
): Promise<AutoPublishResult> {
  const tools = await listForCompany(input.companyId);
  // First active Publish tool whose role gate the agent passes. Empty
  // allowedRoles = visible to every role.
  const publishTool = tools.find(
    (t) =>
      t.type === PUBLISH_TOOL_TYPE &&
      t.status === "active" &&
      (t.allowedRoles.length === 0 ||
        t.allowedRoles.includes(input.agentRole as AgentRole)),
  );
  if (!publishTool) return { resultUri: null };

  const outcome = await invokeTool({
    toolId: publishTool.id,
    actionName: PUBLISH_ACTION,
    companyId: input.companyId,
    deploymentId: input.deploymentId,
    input: {
      title: input.document.title,
      content: input.document.content,
      tags: input.document.tags,
    },
  });

  if (outcome.kind !== "ok") {
    // A non-ok outcome is expected and fine — e.g. the receiver maps no
    // section to this agent's role (422) → the deliverable stays private.
    log.info(
      {
        companyId: input.companyId,
        toolId: publishTool.id,
        outcome: outcome.kind,
      },
      "auto-publish produced no URL",
    );
    return { resultUri: null };
  }

  const url =
    outcome.output &&
    typeof outcome.output === "object" &&
    "url" in outcome.output
      ? (outcome.output as { url?: unknown }).url
      : undefined;
  return {
    resultUri: typeof url === "string" && url.length > 0 ? url : null,
  };
}
