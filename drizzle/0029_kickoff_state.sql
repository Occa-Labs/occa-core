-- Kickoff lifecycle on companies + per-agent provisioning state.
--
-- Drives the post-onboarding flow: CEO discovery dialog → bulk hire
-- approvals → async background provisioning of multiple agents → real-LLM
-- team meeting. UI uses kickoff_state to render the progress banner +
-- replay controls; agents.provisioning_state lets the background worker
-- expose per-agent progress without polling OpenClaw on every UI tick.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "kickoff_state" text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS "kickoff_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "kickoff_completed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "kickoff_meeting_task_id" uuid;

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "provisioning_state" text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS "provisioning_error" text;
