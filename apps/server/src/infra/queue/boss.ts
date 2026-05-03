import { PgBoss } from "pg-boss";
import { childLogger } from "../../lib/logger";

const log = childLogger("pgboss");

export const TASK_DISPATCH_QUEUE = "task.dispatch";

export interface TaskDispatchJobData {
  taskId: string;
}

let instance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance;
  if (starting) return starting;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set — pg-boss cannot start");
  }

  starting = (async () => {
    const boss = new PgBoss({
      connectionString,
      // Isolated schema so pg-boss tables can't collide with app tables.
      schema: "pgboss",
    });

    boss.on("error", (err: unknown) => {
      log.error({ err }, "pg-boss internal error");
    });

    await boss.start();
    log.info("pg-boss started");

    // pg-boss v12 requires explicit queue creation before send()/work().
    // `exclusive` policy: only one job per singletonKey may be queued OR
    // active at a time. Combined with singletonKey=taskId on send(), this
    // guarantees a task can't be dispatched in parallel from two callers.
    await boss.createQueue(TASK_DISPATCH_QUEUE, { policy: "exclusive" });

    instance = boss;
    return boss;
  })();

  return starting;
}

export async function stopBoss(): Promise<void> {
  if (!instance) return;
  await instance.stop({ graceful: true, timeout: 30_000 });
  instance = null;
  starting = null;
  log.info("pg-boss stopped");
}
