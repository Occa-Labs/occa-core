-- On-chain Registry Program — identity/wallet split (Phase 1 MVP).
-- Adds nullable columns to mirror Solana PDA state in Postgres as a cache.
-- Source of truth tetap on-chain; DB cuma index untuk query cepat.
--
-- Spec: occa/docs/identity-architecture.md (CompanyAccount, AgentAccount)
-- Custody MVP: 'sign_to_derive' — agent_address di-derive di FE dari user
-- wallet (signMessage), OCCA tidak menyimpan privkey-nya.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "company_pda"            text UNIQUE,
  ADD COLUMN IF NOT EXISTS "controlling_authority"  text,
  ADD COLUMN IF NOT EXISTS "chain_nonce"            integer,
  ADD COLUMN IF NOT EXISTS "chain_tx_signature"     text;

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "agent_pda"                  text UNIQUE,
  ADD COLUMN IF NOT EXISTS "agent_address"              text,
  ADD COLUMN IF NOT EXISTS "agent_index"                integer,
  ADD COLUMN IF NOT EXISTS "custody_model"              text NOT NULL DEFAULT 'sign_to_derive',
  ADD COLUMN IF NOT EXISTS "derivation_msg_version"    smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "agent_chain_tx_signature"   text;

-- Per-company unique agent_index (matches PDA seed uniqueness on-chain).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_agents_company_agent_index"
  ON "agents" ("company_id", "agent_index")
  WHERE "agent_index" IS NOT NULL;
