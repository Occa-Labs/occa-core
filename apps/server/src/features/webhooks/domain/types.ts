// Webhook domain — the standard outbound payload OCCA emits, and the
// pure filter logic deciding whether a webhook fires for a given task.
// Domain layer: no I/O (see `repositories/` and `services/`).

// The only event today. A completed task settling into `done`.
export const WEBHOOK_EVENT_TASK_COMPLETED = "task.completed";

// The standard payload sent to every subscribed webhook. Deliberately
// destination-neutral: no "section", no product names. The receiver
// maps this to whatever shape it needs — that mapping never lives here.
export interface TaskCompletedPayload {
  event: typeof WEBHOOK_EVENT_TASK_COMPLETED;
  /** ISO timestamp of the completion. */
  occurredAt: string;
  company: { id: string; name: string };
  task: { id: string; title: string; tags: string[]; taskType: string };
  document: {
    title: string;
    /** Markdown body — the agent's clean deliverable. */
    content: string;
    format: string;
    tags: string[];
  };
  agent: { name: string; role: string };
  /**
   * The agent that delegated this task and is accountable for the
   * deliverable. Null when the task had no delegating agent (e.g.
   * created directly by a user). Destination-neutral: a receiver maps
   * this to whatever role-of-record it wants (editor, reviewer, owner).
   */
  delegatedBy: { name: string; role: string } | null;
  trace: { id: string };
}

export interface WebhookFilters {
  roles: string[];
  tags: string[];
  taskTypes: string[];
}

export interface TaskMatchInput {
  role: string;
  tags: string[];
  taskType: string;
}

// A non-empty filter must contain the task's value; an empty filter is
// unconstrained. `tags` matches on any overlap. All filters AND together.
export function webhookMatchesTask(
  filters: WebhookFilters,
  task: TaskMatchInput,
): boolean {
  if (filters.roles.length > 0 && !filters.roles.includes(task.role)) {
    return false;
  }
  if (
    filters.taskTypes.length > 0 &&
    !filters.taskTypes.includes(task.taskType)
  ) {
    return false;
  }
  if (
    filters.tags.length > 0 &&
    !filters.tags.some((tag) => task.tags.includes(tag))
  ) {
    return false;
  }
  return true;
}
