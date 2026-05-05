-- Chain registry refactor: drop sign-to-derive custody model.
--
-- New model:
--   • company.owner = user wallet (was: controlling_authority = operator)
--   • agent.owner = company.owner (user wallet)
--   • agent.operating_wallet = optional user-supplied transactional wallet
--     (defaults to Pubkey::default on-chain; NULL in DB = "not set")
--
-- All state-changing instructions are signed by the user wallet; operator
-- is fee-payer only. Custody / derivation columns disappear.

ALTER TABLE "companies"
  DROP COLUMN IF EXISTS "controlling_authority",
  ADD COLUMN IF NOT EXISTS "owner_wallet" text;

ALTER TABLE "agents"
  DROP COLUMN IF EXISTS "agent_address",
  DROP COLUMN IF EXISTS "custody_model",
  DROP COLUMN IF EXISTS "derivation_msg_version",
  ADD COLUMN IF NOT EXISTS "owner_wallet" text,
  ADD COLUMN IF NOT EXISTS "operating_wallet" text;
