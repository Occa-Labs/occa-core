-- Drop wakeup_request_id from traces (also drops the FK constraint automatically)
ALTER TABLE "traces" DROP COLUMN IF EXISTS "wakeup_request_id";

-- Add new columns directly on traces
ALTER TABLE "traces"
  ADD COLUMN IF NOT EXISTS "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "actor_type" text,
  ADD COLUMN IF NOT EXISTS "actor_id" text,
  ADD COLUMN IF NOT EXISTS "wake_payload" jsonb,
  ADD COLUMN IF NOT EXISTS "coalesced_count" integer NOT NULL DEFAULT 0;

-- Drop the now-unreferenced wakeup requests table
DROP TABLE IF EXISTS "agent_wakeup_requests";
