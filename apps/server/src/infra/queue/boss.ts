import { PgBoss } from "pg-boss";
import { childLogger } from "../../lib/logger";

const log = childLogger("pgboss");

export const TASK_DISPATCH_QUEUE = "task.dispatch";
export const WORKFLOW_EVALUATE_QUEUE = "workflow.evaluate";
// Phase C: each new directive in an agent_dm thread enqueues one job
// keyed by threadId so two concurrent callers can't double-process the
// same thread. The worker resolves "what's pending" by reading the
// thread's chat_messages.
export const AGENT_DM_DISPATCH_QUEUE = "agent_dm.dispatch";
// Auto-reviewer: a delegated task that lands in `review` enqueues one
// job keyed by taskId so the Head reviews it once per landing.
export const REVIEW_DISPATCH_QUEUE = "review.dispatch";
// Sequential workflow start: a routine fire that names a workflow
// enqueues one job keyed by the wrapper taskId. The server creates the
// run row and spawns step 0. Kept separate from workflow.evaluate (which
// advances an in-flight run) so the start trigger is the wrapper's
// creation, not a done-transition.
export const WORKFLOW_START_QUEUE = "workflow.start";

export interface TaskDispatchJobData {
  taskId: string;
}

export interface WorkflowEvaluateJobData {
  taskId: string;
}

export interface AgentDmDispatchJobData {
  threadId: string;
}

export interface ReviewDispatchJobData {
  taskId: string;
}

export interface WorkflowStartJobData {
  // The routine wrapper task all step children will hang under.
  parentTaskId: string;
  companyId: string;
  // Which workflow to instantiate, by its per-company yaml id.
  workflowYamlId: string;
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
    // Same exclusive policy for workflow evaluations — ensures a single
    // task done-transition can't trigger concurrent engine runs.
    await boss.createQueue(WORKFLOW_EVALUATE_QUEUE, { policy: "exclusive" });
    // Phase C: agent_dm thread dispatch. Exclusive per-thread so a
    // burst of directives on the same DM thread serialises.
    await boss.createQueue(AGENT_DM_DISPATCH_QUEUE, { policy: "exclusive" });
    // Auto-reviewer dispatch. Exclusive per-task so one task can't have
    // two Head reviews running at once.
    await boss.createQueue(REVIEW_DISPATCH_QUEUE, { policy: "exclusive" });
    // Sequential workflow start. Exclusive per wrapper task so a routine
    // fire can't spawn two runs for the same wrapper.
    await boss.createQueue(WORKFLOW_START_QUEUE, { policy: "exclusive" });

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
