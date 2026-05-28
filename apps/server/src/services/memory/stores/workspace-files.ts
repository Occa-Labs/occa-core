// Workspace files store — loads the persona / operating markdown the
// agent's identity lives in (SOUL.md, AGENTS.md, IDENTITY.md, etc).
// Source of truth is OCCA's `deployment_workspace_files` table — the
// rendered template (or user-edited override) seeded at deploy time.
//
// Adapters with their own per-agent filesystem (OpenClaw) can also read
// these via a read_file tool — they were pushed there by
// `adapter.seedWorkspace` at create. For adapters without a filesystem
// (Hermes), the prompt is the ONLY place the agent ever sees this
// content, so renderers inline it. Loading is uniform regardless of
// adapter — the renderer decides whether to inline or pointer to a
// file path.

import { eq } from "drizzle-orm";
import { deploymentWorkspaceFiles } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import type { ContextWorkspaceFile } from "../spec";

export async function loadWorkspaceFiles(args: {
  deploymentId: string;
}): Promise<ContextWorkspaceFile[]> {
  const rows = await db
    .select({
      filename: deploymentWorkspaceFiles.filename,
      content: deploymentWorkspaceFiles.content,
    })
    .from(deploymentWorkspaceFiles)
    .where(eq(deploymentWorkspaceFiles.deploymentId, args.deploymentId));
  return rows.map((r) => ({ filename: r.filename, content: r.content }));
}
