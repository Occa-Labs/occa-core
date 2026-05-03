import { acquireLeader } from "./leader";
import { startDispatcherLoop } from "./dispatcher";
import { startSchedulerLoop } from "./scheduler";
import { startConnectionProbeLoop } from "./connection-probe";
import { startSkillSyncLoop } from "./skill-sync";
import { pool } from "./db";

async function main() {
  let leader: Awaited<ReturnType<typeof acquireLeader>>;
  try {
    leader = await acquireLeader();
  } catch (err) {
    if (err instanceof Error && err.message === "leader_already_held") {
      console.log("[worker] leader held by another process — exiting");
      process.exit(0);
    }
    throw err;
  }
  console.log(`[worker] leader acquired pid=${process.pid}`);

  const stopDispatcher = startDispatcherLoop();
  const stopScheduler = startSchedulerLoop();
  const stopProbe = startConnectionProbeLoop();
  const stopSkillSync = startSkillSyncLoop();

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — shutting down`);
    stopDispatcher();
    stopScheduler();
    stopProbe();
    stopSkillSync();
    await leader.release();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(
    "[worker] fatal:",
    err instanceof Error ? err.stack ?? err.message : err,
  );
  process.exit(1);
});
