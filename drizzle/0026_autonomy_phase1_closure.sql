-- Phase 1 autonomy closure — adds the schema bits the BLOCK / ASK / @mention
-- action handlers need:
--   * tasks.blocked_by_task_ids   uuid[] — blockers a task is waiting on
--   * task_comments               new table — agent-to-agent + user comms
--                                 with @mention parsing for wake routing
-- `tasks.status` keeps a free-form `text` shape (no enum), so the new
-- `blocked` value lands without an ALTER TYPE.

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "blocked_by_task_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

CREATE TABLE IF NOT EXISTS "task_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" uuid,
  "body" text NOT NULL,
  "mentions" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "created_at" timestamp with time zone NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_author_agent_id_fkey"
    FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "task_comments"
    ADD CONSTRAINT "task_comments_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_task_comments_task"
  ON "task_comments"("task_id");
CREATE INDEX IF NOT EXISTS "idx_task_comments_company_created"
  ON "task_comments"("company_id", "created_at");
