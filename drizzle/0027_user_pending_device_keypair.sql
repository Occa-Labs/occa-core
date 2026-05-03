-- Persist the OpenClaw device keypair across probe + provision so the user
-- only approves pairing once. Cleared after successful provision (keypair
-- migrates to agent.adapter_config.deviceKeypair from then on).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "pending_device_keypair" jsonb;
