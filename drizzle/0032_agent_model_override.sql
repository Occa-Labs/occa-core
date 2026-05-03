-- Optional override for the 3D character model rendered for an agent in
-- the office scene. NULL = derive deterministically via
-- `buildAgentModelMap` claim-and-skip on the web. Non-NULL = pin this
-- agent to the chosen GLB regardless of role / hire order. Set from the
-- Overview tab character picker.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "model_override" text;
