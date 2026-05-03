-- Autonomy slice: hire-with-approval flow.
--
-- Adds the schema fields the DELEGATE → approval → child task creation
-- flow needs:
--   * agents.parent_agent_id     reports-to / org tree (self FK)
--   * tasks.parent_task_id       parent/child task graph
--   * tasks.created_by_agent_id  marks tasks born from agent action
--   * tasks.acceptance_criteria  delegation contract
--   * tasks.created_by_user_id   relax NOT NULL (agent-created tasks
--                                have created_by_agent_id instead)

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "parent_agent_id" uuid;
DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_parent_agent_id_fkey"
    FOREIGN KEY ("parent_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_task_id" uuid;
DO $$ BEGIN
  ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_parent_task_id_fkey"
    FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid;
DO $$ BEGIN
  ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_created_by_agent_id_fkey"
    FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "acceptance_criteria" text;

ALTER TABLE "tasks" ALTER COLUMN "created_by_user_id" DROP NOT NULL;
