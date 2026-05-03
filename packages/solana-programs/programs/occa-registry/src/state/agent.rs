use anchor_lang::prelude::*;

/// Three custody models for agent signing keys (§8.2.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum CustodyModel {
    /// Default — keypair derived from company's controlling signer via
    /// hardened SLIP-0010 path over Ed25519.  OCCA delegated signer
    /// produces commit_trace signatures on behalf of the agent.
    Derived,
    /// Threshold MPC — signing key exists only as distributed shares
    /// (operator + OCCA + optional 3rd party). No single party can sign
    /// without quorum. Opt-in from Phase 1.
    Threshold,
    /// Enterprise custodial — OCCA-managed signer holds the key and signs
    /// only under pre-configured policy. Available on dedicated infra tier.
    Custodial,
}

/// Agent lifecycle status.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum AgentStatus {
    Active,
    Degraded,
    Retired,
}

/// Seeds: ["agent", company_pda, agent_index_le_bytes]
/// One PDA per agent within a company (§5.1.2, §8.2.3).
#[account]
pub struct AgentAccount {
    pub version: u8,
    /// Owning company PDA.
    pub company: Pubkey,
    /// Agent's signing address (stable on-chain identity).
    pub agent_address: Pubkey,
    /// Signing-key custody model selected at creation (immutable).
    pub custody_model: CustodyModel,
    /// Derivation index used under Derived custody; rotated on key compromise.
    pub derivation_index: u32,
    /// Reference to role catalog entry.
    pub role_id: u32,
    /// Pinned adapter version for this agent.
    pub adapter_id: Pubkey,
    /// Lifecycle state.
    pub status: AgentStatus,
    /// Pointer to off-chain agent metadata.
    pub metadata_uri: String,
    /// Index used as seed — preserved for re-derivation.
    pub agent_index: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AgentAccount {
    pub const MAX_SIZE: usize = 8 + 1 + 32 + 32 + 2 + 4 + 4 + 32 + 2 + (4 + 200) + 4 + 8 + 8;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"agent";
}
