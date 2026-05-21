// pg-boss enqueue for the worker.
//
// A routine-delegated task must run through the SERVER's task dispatcher
// (`features/tasks/services/dispatcher.ts`) — that path owns the
// verification gate + auto-save. The server consumes the `task.dispatch`
// pg-boss queue; the worker only SENDs to it. Dispatching a delegated
// task via the worker's own `wakeup()` trace-claim path would skip the
// gate entirely.
//
// Queue name + job shape MUST match apps/server/src/infra/queue/boss.ts.

import { PgBoss } from "pg-boss";

const TASK_DISPATCH_QUEUE = "task.dispatch";

let instance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

async function getBoss(): Promise<PgBoss> {
  if (instance) return instance;
  if (starting) return starting;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set — pg-boss cannot start");
  }

  starting = (async () => {
    const boss = new PgBoss({ connectionString, schema: "pgboss" });
    boss.on("error", (err: unknown) => {
      console.error("[worker:queue] pg-boss error:", err);
    });
    await boss.start();
    // Idempotent — the server creates this queue on its own boot;
    // re-creating with the same config is a no-op. Doing it here too
    // keeps the worker independent of process boot order.
    await boss.createQueue(TASK_DISPATCH_QUEUE, { policy: "exclusive" });
    instance = boss;
    return boss;
  })();

  return starting;
}

// Enqueue a task for the server's gated dispatcher. `singletonKey` =
// taskId mirrors the server's own enqueue so a task can't be
// double-dispatched while one job is queued or active.
export async function enqueueTaskDispatch(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(
    TASK_DISPATCH_QUEUE,
    { taskId },
    {
      singletonKey: taskId,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
    },
  );
}
