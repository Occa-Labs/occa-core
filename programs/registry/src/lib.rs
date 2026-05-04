// OCCA Registry Program — Phase 1 MVP.
//
// Owns CompanyAccount and AgentAccount PDAs. Other programs in the OCCA
// suite (Treasury, Trace Anchor, Marketplace, Reputation) will be added in
// later phases — for now CompanyAccount carries placeholder Pubkeys for
// `treasury` and `policy` so the schema is forward-compatible.
//
// Spec: occa/docs/identity-architecture.md
//
// Custody model encoding (`AgentAccount.custody_model`):
//   0 = Derived       (SLIP-0010 — operator-side master seed)
//   1 = Custodial     (OCCA-managed signer)
//   2 = Threshold     (k-of-n MPC)
//   3 = SignToDerive  (FE wallet signMessage → blake3 → keypair) — MVP default

use anchor_lang::prelude::*;

declare_id!("oCCAYWgH3KTWccrdHUkrGZQK8YAGTNVQp4V4Hxsv8LQ");

pub const MAX_METADATA_URI_LEN: usize = 200;

// Account schema versions — bump when fields change. Read-only programs
// (Reputation, etc.) gate on these to stay forward-compatible.
pub const COMPANY_ACCOUNT_VERSION: u8 = 1;
pub const AGENT_ACCOUNT_VERSION: u8 = 1;

// Status encoding for AgentAccount.status.
pub const AGENT_STATUS_ACTIVE: u8 = 0;
#[allow(dead_code)]
pub const AGENT_STATUS_DEGRADED: u8 = 1;
#[allow(dead_code)]
pub const AGENT_STATUS_RETIRED: u8 = 2;

// Highest valid custody_model value (inclusive).
pub const MAX_CUSTODY_MODEL: u8 = 3;

#[program]
pub mod registry {
    use super::*;

    /// Create a new CompanyAccount PDA.
    ///
    /// Seeds: `["company", controlling_authority, nonce_le_u32]`
    ///
    /// `nonce` lets a single controlling_authority own multiple companies.
    /// Server-side picks the next free nonce per authority. `metadata_uri`
    /// is an off-chain pointer (IPFS / Arweave / HTTPS) — empty string is
    /// allowed for MVP.
    pub fn create_company(
        ctx: Context<CreateCompany>,
        nonce: u32,
        metadata_uri: String,
    ) -> Result<()> {
        require!(
            metadata_uri.len() <= MAX_METADATA_URI_LEN,
            RegistryError::MetadataUriTooLong
        );

        let company = &mut ctx.accounts.company;
        company.version = COMPANY_ACCOUNT_VERSION;
        company.controlling_authority = ctx.accounts.authority.key();
        // Treasury / Policy programs are deployed in a later phase. We
        // pin Pubkey::default() here so clients can detect "not yet
        // wired" via `treasury == Pubkey::default()`.
        company.treasury = Pubkey::default();
        company.policy = Pubkey::default();
        company.created_at = Clock::get()?.unix_timestamp;
        company.nonce = nonce;
        company.metadata_uri = metadata_uri;
        Ok(())
    }

    /// Create a new AgentAccount PDA under an existing company.
    ///
    /// Seeds: `["agent", company_pda, agent_index_le_u32]`
    ///
    /// `agent_index` is a per-company u32 counter (NOT a UUID) — server
    /// is responsible for picking the next free index. `agent_address` is
    /// the wallet that will sign trace anchors (later phase). For MVP
    /// custody_model=3 (SignToDerive), the FE derives this pubkey via
    /// wallet.signMessage and OCCA never holds the privkey.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_index: u32,
        agent_address: Pubkey,
        custody_model: u8,
        role_id: u32,
        adapter_id: Pubkey,
    ) -> Result<()> {
        require!(
            custody_model <= MAX_CUSTODY_MODEL,
            RegistryError::InvalidCustodyModel
        );

        let agent = &mut ctx.accounts.agent;
        agent.version = AGENT_ACCOUNT_VERSION;
        agent.company = ctx.accounts.company.key();
        agent.agent_address = agent_address;
        agent.custody_model = custody_model;
        // derivation_index is reserved for SLIP-0010 rotation flow (Phase
        // 3). For SignToDerive it stays 0 — the per-agent uniqueness comes
        // from `agent_index` already baked into the PDA seed.
        agent.derivation_index = 0;
        agent.agent_index = agent_index;
        agent.role_id = role_id;
        agent.adapter_id = adapter_id;
        agent.status = AGENT_STATUS_ACTIVE;
        Ok(())
    }
}

// ─── Account contexts ──────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(nonce: u32, metadata_uri: String)]
pub struct CreateCompany<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + CompanyAccount::INIT_SPACE,
        seeds = [b"company", authority.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub company: Account<'info, CompanyAccount>,

    /// The future `controlling_authority` of the company. Required to
    /// sign so a third party can't squat someone else's authority+nonce
    /// PDA. For MVP this is the operator hot wallet.
    pub authority: Signer<'info>,

    /// Pays rent for the new account. May or may not equal `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_index: u32)]
pub struct RegisterAgent<'info> {
    /// Existing company. `has_one` enforces that `controlling_authority`
    /// (signer below) matches the field stored on the company.
    #[account(
        has_one = controlling_authority @ RegistryError::Unauthorized,
    )]
    pub company: Account<'info, CompanyAccount>,

    /// Must match `company.controlling_authority`.
    pub controlling_authority: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + AgentAccount::INIT_SPACE,
        seeds = [b"agent", company.key().as_ref(), &agent_index.to_le_bytes()],
        bump,
    )]
    pub agent: Account<'info, AgentAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Account schemas ───────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct CompanyAccount {
    /// Schema version — bump on field changes.
    pub version: u8,
    /// Privileged-class signer for this company.
    pub controlling_authority: Pubkey,
    /// Pointer to TreasuryAccount PDA (Pubkey::default() until Phase 2).
    pub treasury: Pubkey,
    /// Pointer to PolicyAccount PDA (Pubkey::default() until Phase 2).
    pub policy: Pubkey,
    /// Unix timestamp (seconds) at creation.
    pub created_at: i64,
    /// Seed disambiguator — same authority can own multiple companies.
    pub nonce: u32,
    /// Off-chain metadata URI (IPFS / Arweave / HTTPS). Bounded by
    /// MAX_METADATA_URI_LEN to keep account size predictable.
    #[max_len(200)]
    pub metadata_uri: String,
}

#[account]
#[derive(InitSpace)]
pub struct AgentAccount {
    pub version: u8,
    /// Owning CompanyAccount PDA.
    pub company: Pubkey,
    /// Wallet that will sign agent-side actions (e.g. commit_trace later).
    pub agent_address: Pubkey,
    /// See top-of-file mapping.
    pub custody_model: u8,
    /// SLIP-0010 hardened derivation index. Reserved for Phase 3 rotation.
    pub derivation_index: u32,
    /// Per-company counter — also part of the PDA seed.
    pub agent_index: u32,
    /// Reference to a role catalog entry (off-chain).
    pub role_id: u32,
    /// Pinned adapter version. Pubkey::default() = unspecified.
    pub adapter_id: Pubkey,
    /// 0=Active, 1=Degraded, 2=Retired.
    pub status: u8,
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum RegistryError {
    #[msg("metadata_uri exceeds MAX_METADATA_URI_LEN")]
    MetadataUriTooLong,
    #[msg("custody_model is not a known variant")]
    InvalidCustodyModel,
    #[msg("signer does not match company.controlling_authority")]
    Unauthorized,
}
