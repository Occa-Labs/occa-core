-- Drop agent hire requests table and remove hire-related columns from agents.
-- This migration removes the agent-hire feature entirely.

-- Drop table with all its constraints and indexes (cascade).
DROP TABLE IF EXISTS "agent_hire_requests" CASCADE;

-- Remove hire-related columns from agents table.
ALTER TABLE "agents" DROP COLUMN IF EXISTS "reports_to_agent_id";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "can_create_agents";

-- Drop the now-orphaned index (if not already dropped by DROP COLUMN).
DROP INDEX IF EXISTS "idx_agents_reports_to";
