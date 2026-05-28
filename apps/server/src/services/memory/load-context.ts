// Context assembler for the memory pipeline.
//
// `loadContext()` is the single entry point every prompt surface (chat,
// task, future heartbeat) calls. It loads no data itself — it composes
// the per-type memory stores in `stores/` into one `ContextSpec`.
//
// Memory vs context (the distinction this module is built around):
//   • stores/ hold durable memory by TYPE — identity, org, semantic
//     (knowledge), episodic (history). Each is its own concern.
//   • this file decides load CADENCE — which stores to pull and how much,
//     per surface — and assembles the per-run ContextSpec the renderers
//     consume. Memory is what is stored; context is what a single run
//     loads. Never load the whole of a store; load the slice that run
//     needs.
//
// Cadence today:
//   • always-on — identity (cheap, every turn)
//   • session   — org chart (refreshed each call; tiny query, avoids
//                 staleness when the owner deploys mid-session)
//   • on-demand — semantic + episodic (retrieval-shaped, surface-branched)
// Tier 4 (gateway filesystem) is not assembled here — renderers emit
// pointers (e.g. "read ./SOUL.md") and the agent fetches via its tools.
//
// Cross-cutting placement: lives in `services/` rather than any
// `features/<x>/` because three independent features (chat, tasks,
// future heartbeat) share it. Importing from features.repositories is
// allowed for service-tier code per CLAUDE.md (the cross-feature ban
// applies feature-to-feature, not service-to-feature).

import { ContextNotFoundError, loadIdentity } from "./stores/identity";
import { loadOrg } from "./stores/org";
import { loadKnowledge } from "./stores/semantic";
import { loadHistory } from "./stores/episodic";
import { loadSkills } from "./stores/skills";
import { loadWorkspaceFiles } from "./stores/workspace-files";
import type {
  ContextRuntimeEnv,
  ContextSpec,
  SurfacePayload,
} from "./spec";

export { ContextNotFoundError };

export async function loadContext(args: {
  deploymentId: string;
  surface: SurfacePayload;
  // Per-trace credentials minted by the dispatcher. Passing them through
  // loadContext keeps the renderer pure — it never touches the DB to
  // mint a key. Chat-mode callers without a trace pass `undefined`.
  runtimeEnv?: ContextRuntimeEnv;
}): Promise<ContextSpec> {
  // Identity first — everything downstream is scoped by its companyId.
  const { agent, company } = await loadIdentity(args.deploymentId);

  const [org, knowledge, history, skills, workspaceFiles] = await Promise.all([
    loadOrg({
      deploymentId: args.deploymentId,
      companyId: company.id,
    }),
    // Knowledge is visibility-filtered to the agent's tier; history is
    // branched by surface. Both are optional — renderers handle absence.
    loadKnowledge({
      companyId: company.id,
      agentTier: agent.tier,
    }),
    loadHistory({
      companyId: company.id,
      surface: args.surface,
    }),
    loadSkills({
      deploymentId: args.deploymentId,
      companyId: company.id,
    }),
    loadWorkspaceFiles({ deploymentId: args.deploymentId }),
  ]);

  return {
    agent,
    company,
    org,
    knowledge,
    history,
    skills,
    workspaceFiles,
    runtimeEnv: args.runtimeEnv,
    surface: args.surface,
  };
}
