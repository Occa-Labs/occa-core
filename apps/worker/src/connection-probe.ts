import {
  agentRuntimeProfile,
  deploymentRuntimeState,
} from "@occa/shared/schema";
import { db } from "./db";
import { getAdapter } from "./adapter-registry";

const TICK_INTERVAL_MS = 90_000;
const PROBE_TIMEOUT_MS = 10_000;

async function probeProfile(
  row: typeof agentRuntimeProfile.$inferSelect,
): Promise<{
  state: "connected" | "disconnected" | "unknown";
  error: string | null;
}> {
  const adapter = getAdapter(row.adapterType);
  if (!adapter) {
    return { state: "unknown", error: `no_adapter:${row.adapterType}` };
  }
  // Skip deployments that are not fully provisioned. Probing them with a
  // fresh ephemeral keypair (the adapter's fallback) generates pending
  // pair requests on the gateway every 90s — log spam + wasted load.
  if (row.provisioningState !== "ready") {
    return {
      state: "unknown",
      error: `provisioning_state:${row.provisioningState}`,
    };
  }
  // Defensive: OpenClaw's probeConnection falls back to generating an
  // ephemeral keypair when adapterConfig has no `deviceKeypair`, which
  // creates a fresh unpaired device on the gateway every 90s = spam.
  // Other adapters don't share this fallback (Hermes hits a plain HTTP
  // endpoint with a bearer token), so the gate only applies to openclaw.
  const cfg = (row.adapterConfig as Record<string, unknown> | null) ?? {};
  if (row.adapterType === "openclaw" && !cfg.deviceKeypair) {
    return { state: "unknown", error: "no_device_keypair" };
  }
  try {
    const res = await Promise.race([
      adapter.probeConnection(cfg),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe_timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    if (res.ok) return { state: "connected", error: null };
    return { state: "disconnected", error: res.error ?? "unknown_error" };
  } catch (err) {
    return {
      state: "disconnected",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function tick(): Promise<void> {
  const rows = await db.select().from(agentRuntimeProfile);
  if (rows.length === 0) return;

  // Probe in parallel; each failure is self-contained so one bad adapter
  // doesn't block others. Upsert one row at a time for clarity over a
  // batch CTE — N is small (per-company deployment count).
  await Promise.all(
    rows.map(async (row) => {
      const result = await probeProfile(row);
      const now = new Date();
      await db
        .insert(deploymentRuntimeState)
        .values({
          deploymentId: row.deploymentId,
          companyId: row.companyId,
          connectionState: result.state,
          connectionCheckedAt: now,
          connectionError: result.error,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: deploymentRuntimeState.deploymentId,
          set: {
            connectionState: result.state,
            connectionCheckedAt: now,
            connectionError: result.error,
            updatedAt: now,
          },
        });
    }),
  );
}

export function startConnectionProbeLoop(): () => void {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      const cause =
        err instanceof Error && "cause" in err
          ? (err as { cause: unknown }).cause
          : undefined;
      console.error(
        "[connection-probe] tick error:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      if (cause) {
        const causeMsg =
          cause instanceof Error ? (cause.stack ?? cause.message) : cause;
        console.error("[connection-probe] caused by:", causeMsg);
      }
    } finally {
      running = false;
    }
  };

  // Fire once immediately so newly-started workers don't leave deployments
  // in "unknown" for the full interval on first boot.
  void run();
  timer = setInterval(() => void run(), TICK_INTERVAL_MS);

  console.log(
    `[connection-probe] started (interval=${TICK_INTERVAL_MS / 1000}s)`,
  );

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
