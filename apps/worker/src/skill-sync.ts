// Background worker: installs/uninstalls skills on provisioned OpenClaw agents.
// Reads pending rows from agent_skill_syncs, sends prompts to the agent via the
// OpenClaw gateway WebSocket, and parses [[SKILL:INSTALLED]] /
// [[SKILL:FAILED]] / [[SKILL:REMOVED]] markers from the agent reply.
//
// Each skill fires a long-lived sendAgentPrompt as a detached background promise.
// inFlight prevents double-firing on subsequent ticks. Parallel across skills;
// if the worker restarts, installing rows older than 5 min are automatically re-tried.

import { eq, inArray, sql } from "drizzle-orm";
import { agents, agentSkillSyncs, companySkills } from "@occa/shared/schema";
import {
  deleteAgentSession,
  deserializeKeypair,
  sendAgentPrompt,
  type SerializedKeypair,
} from "@occa/adapter-openclaw";
import { db } from "./db";

const TICK_INTERVAL_MS = 30_000;
const SKILL_SESSION_PREFIX = "skill";
const SKILL_WAIT_TIMEOUT_MS = 30 * 60_000;

function buildSkillInstallPrompt(skillKey: string, treeUrl: string): string {
  return [
    `Please install the following skill into your toolkit.`,
    ``,
    `Skill key: ${skillKey}`,
    `Skill repository: ${treeUrl}`,
    ``,
    `Instructions:`,
    `1. Browse the skill repository URL above to understand the skill.`,
    `2. Follow any installation instructions in the skill's SKILL.md or README.`,
    `3. If the skill includes scripts, download and register them as tools.`,
    `4. Once the skill is fully installed and operational, reply with the exact marker:`,
    `   [[SKILL:INSTALLED]]`,
    `5. If installation fails for any reason, reply with:`,
    `   [[SKILL:FAILED]] followed by a brief reason.`,
  ].join("\n");
}

// Platform-shipped skills (metadata.platform === true) don't live on GitHub.
// Their markdown is the contract itself — written + versioned in OCCA's own
// codebase (see services/seed-runtime-skill.ts). The install prompt embeds
// the content directly so the agent doesn't try to fetch a non-existent
// repository URL.
function buildPlatformSkillInstallPrompt(
  skillKey: string,
  markdown: string,
): string {
  return [
    `Please install the following platform skill into your toolkit.`,
    `The skill content is provided directly below — no external fetch is`,
    `required and no repository exists to clone from.`,
    ``,
    `Skill key: ${skillKey}`,
    ``,
    `Instructions:`,
    `1. Read the skill content carefully.`,
    `2. Internalize the protocol it describes (API contracts, markers,`,
    `   callback URLs) so you can apply it on future turns.`,
    `3. If the skill ships any scripts or tools (look for that section),`,
    `   register them.`,
    `4. Once you understand the skill and are ready to apply it, reply with`,
    `   the exact marker:`,
    `   [[SKILL:INSTALLED]]`,
    `5. If something prevents installation, reply with:`,
    `   [[SKILL:FAILED]] followed by a brief reason.`,
    ``,
    `--- BEGIN SKILL CONTENT (${skillKey}) ---`,
    ``,
    markdown,
    ``,
    `--- END SKILL CONTENT (${skillKey}) ---`,
  ].join("\n");
}

function buildSkillUninstallPrompt(skillKey: string): string {
  return [
    `Please remove the following skill from your toolkit.`,
    ``,
    `Skill key: ${skillKey}`,
    ``,
    `Instructions:`,
    `1. Unregister any tools added by this skill.`,
    `2. Remove any scripts or files installed for this skill.`,
    `3. Once fully removed, reply with the exact marker:`,
    `   [[SKILL:REMOVED]]`,
    `4. If removal fails, reply with:`,
    `   [[SKILL:FAILED]] followed by a brief reason.`,
  ].join("\n");
}

function parseMarker(
  reply: string,
): "installed" | "failed" | "removed" | null {
  if (reply.includes("[[SKILL:INSTALLED]]")) return "installed";
  if (reply.includes("[[SKILL:REMOVED]]")) return "removed";
  if (reply.includes("[[SKILL:FAILED]]")) return "failed";
  return null;
}

type SyncRow = typeof agentSkillSyncs.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function agentGatewayConfig(agent: AgentRow) {
  const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  if (
    typeof cfg.gatewayUrl !== "string" ||
    typeof cfg.apiKey !== "string" ||
    !cfg.deviceKeypair ||
    !agent.externalAgentId
  ) return null;
  return {
    gatewayUrl: cfg.gatewayUrl as string,
    apiKey: cfg.apiKey as string,
    device: deserializeKeypair(cfg.deviceKeypair as SerializedKeypair),
    openclawAgentId:
      typeof cfg.openclawAgentId === "string"
        ? cfg.openclawAgentId
        : agent.externalAgentId,
  };
}

// Returns the parsed marker so the caller can decide on follow-up actions
// (e.g. cleaning up the install session). `null` = no recognised marker —
// also a terminal failure for this attempt, but distinct from an
// agent-reported failure since the agent's response was malformed rather
// than explicit.
async function applyMarker(
  syncRow: SyncRow,
  reply: string,
  skillUrl: string | null,
): Promise<"installed" | "removed" | "failed" | null> {
  const marker = parseMarker(reply);
  const now = new Date();
  if (marker === "installed") {
    await db.update(agentSkillSyncs).set({
      status: "installed",
      lastError: null,
      gatewayRunId: null,
      skillUrl: skillUrl ?? syncRow.skillUrl,
      installedAt: now,
      updatedAt: now,
    }).where(eq(agentSkillSyncs.id, syncRow.id));
  } else if (marker === "removed") {
    await db.delete(agentSkillSyncs).where(eq(agentSkillSyncs.id, syncRow.id));
  } else if (marker === "failed") {
    const reason = reply.replace("[[SKILL:FAILED]]", "").trim().slice(0, 500);
    await db.update(agentSkillSyncs).set({
      status: "failed",
      lastError: reason || "agent_reported_failure",
      gatewayRunId: null,
      updatedAt: now,
    }).where(eq(agentSkillSyncs.id, syncRow.id));
  } else {
    await db.update(agentSkillSyncs).set({
      status: "failed",
      lastError: "no_marker_in_reply",
      gatewayRunId: null,
      updatedAt: now,
    }).where(eq(agentSkillSyncs.id, syncRow.id));
  }
  return marker;
}

// Drop the install-conversation session from the gateway after a terminal
// outcome so the OpenClaw dashboard dropdown stays clean. Best-effort —
// failures don't change the install result; we just log and move on. The
// gateway protects the agent's main session from this RPC, so passing the
// per-skill key here is always safe.
async function cleanupInstallSession(
  gw: NonNullable<ReturnType<typeof agentGatewayConfig>>,
  sessionKey: string,
): Promise<void> {
  try {
    const result = await deleteAgentSession({
      gatewayUrl: gw.gatewayUrl,
      apiKey: gw.apiKey,
      device: gw.device,
      sessionKey,
    });
    if (!result.ok) {
      console.warn(
        `[skill-sync] sessions.delete sessionKey=${sessionKey} failed: ${result.error}${result.reason ? ` — ${result.reason}` : ""}`,
      );
    }
  } catch (err) {
    console.warn(
      `[skill-sync] sessions.delete sessionKey=${sessionKey} crashed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Tracks sync row IDs currently processing in this worker instance.
// Prevents tick() from double-firing a row that's already awaiting a reply.
const inFlight = new Set<string>();

interface SkillLibSummary {
  treeUrl: string | null;
  /** True when the skill is OCCA-platform-shipped (markdown-only, no GitHub repo). */
  isPlatform: boolean;
  /** Inline markdown body — used by platform skills for the install prompt. */
  markdown: string | null;
}

async function processRow(
  syncRow: SyncRow,
  agent: AgentRow,
  lib: SkillLibSummary,
): Promise<void> {
  const gw = agentGatewayConfig(agent);
  if (!gw) {
    await db.update(agentSkillSyncs).set({
      status: "failed", lastError: "agent_not_configured", updatedAt: new Date(),
    }).where(eq(agentSkillSyncs.id, syncRow.id));
    return;
  }

  const isUninstall = syncRow.action === "uninstall";
  const message = isUninstall
    ? buildSkillUninstallPrompt(syncRow.skillKey)
    : lib.isPlatform && lib.markdown
      ? buildPlatformSkillInstallPrompt(syncRow.skillKey, lib.markdown)
      : buildSkillInstallPrompt(syncRow.skillKey, lib.treeUrl ?? syncRow.skillKey);

  const sessionKey = `agent:${gw.openclawAgentId}:${SKILL_SESSION_PREFIX}:${syncRow.skillKey.replace(/\//g, "-")}`;

  await db.update(agentSkillSyncs).set({
    status: "installing",
    skillUrl: lib.treeUrl ?? syncRow.skillUrl,
    gatewayRunId: null,
    updatedAt: new Date(),
  }).where(eq(agentSkillSyncs.id, syncRow.id));

  console.log(`[skill-sync] firing agent=${syncRow.agentId} key=${syncRow.skillKey}`);

  const result = await sendAgentPrompt(
    { ...gw, sessionKey, message },
    { waitTimeoutMs: SKILL_WAIT_TIMEOUT_MS },
  );

  if (!result.ok) {
    await db.update(agentSkillSyncs).set({
      status: "failed",
      lastError: result.reason ?? result.error,
      updatedAt: new Date(),
    }).where(eq(agentSkillSyncs.id, syncRow.id));
    return;
  }

  const marker = await applyMarker(syncRow, result.reply, lib.treeUrl);
  console.log(`[skill-sync] done agent=${syncRow.agentId} key=${syncRow.skillKey} reply=${result.reply.slice(0, 120)}`);

  // Terminal outcome — drop the install session from the gateway so the
  // OpenClaw dashboard dropdown doesn't accumulate one entry per skill.
  // Skip cleanup when there's no recognised marker: the agent's reply was
  // malformed but the prompt itself completed, so we treat this as a
  // user-visible bug worth keeping the transcript around for.
  if (marker === "installed" || marker === "removed" || marker === "failed") {
    await cleanupInstallSession(gw, sessionKey);
  }
}

async function tick(): Promise<void> {
  // Pick up pending rows and installing rows that are stale (worker restarted).
  // Rows in inFlight are skipped — they are actively being processed.
  const staleThreshold = new Date(Date.now() - 5 * 60_000);
  const candidates = await db
    .select()
    .from(agentSkillSyncs)
    .where(
      sql`${agentSkillSyncs.status} = 'pending'
        OR (${agentSkillSyncs.status} = 'installing' AND ${agentSkillSyncs.updatedAt} < ${staleThreshold})`,
    );

  const toProcess = candidates.filter((r) => !inFlight.has(r.id));
  if (toProcess.length === 0) return;

  const agentIds = [...new Set(toProcess.map((r) => r.agentId))];
  const agentRows = await db.select().from(agents).where(inArray(agents.id, agentIds));
  const agentMap = new Map(agentRows.map((a) => [a.id, a]));

  const skillKeys = [...new Set(toProcess.map((r) => r.skillKey))];
  const skillLibRows = await db
    .select({
      key: companySkills.key,
      sourceOwner: companySkills.sourceOwner,
      sourceRepo: companySkills.sourceRepo,
      sourcePath: companySkills.sourcePath,
      sourceRef: companySkills.sourceRef,
      markdown: companySkills.markdown,
      metadata: companySkills.metadata,
    })
    .from(companySkills)
    .where(inArray(companySkills.key, skillKeys));
  const skillLibMap = new Map(skillLibRows.map((s) => [s.key, s]));

  for (const row of toProcess) {
    if (inFlight.has(row.id)) continue;
    const agent = agentMap.get(row.agentId);
    if (!agent) continue;

    const lib = skillLibMap.get(row.skillKey);
    const meta = (lib?.metadata ?? {}) as Record<string, unknown>;
    const isPlatform = meta.platform === true;
    const summary: SkillLibSummary = {
      // Platform skills don't live on GitHub — their `sourceOwner/Repo`
      // are placeholders; building a tree URL would yield 404s. Skip the
      // URL entirely so the install prompt path branches to inline-markdown.
      treeUrl:
        lib && !isPlatform
          ? `https://github.com/${lib.sourceOwner}/${lib.sourceRepo}/tree/${lib.sourceRef}/${lib.sourcePath}`
          : null,
      isPlatform,
      markdown: lib?.markdown ?? null,
    };

    inFlight.add(row.id);
    void processRow(row, agent, summary)
      .catch((err) =>
        console.error(
          `[skill-sync] error agent=${row.agentId} key=${row.skillKey}:`,
          err instanceof Error ? err.stack ?? err.message : err,
        )
      )
      .finally(() => inFlight.delete(row.id));
  }
}

export function startSkillSyncLoop(): () => void {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error(
        "[skill-sync] tick error:",
        err instanceof Error ? err.stack ?? err.message : err,
      );
    } finally {
      running = false;
    }
  };

  void run();
  timer = setInterval(() => void run(), TICK_INTERVAL_MS);
  console.log(`[skill-sync] started (interval=${TICK_INTERVAL_MS / 1000}s)`);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
