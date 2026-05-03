use anchor_lang::prelude::*;

/// Seeds: ["trace", task_id]
/// Immutable on-chain anchor for a completed task's trace (§8.3, §9.2).
///
/// The integrity guarantee: any party with the off-chain content can
/// recompute Blake3(canonical_bytes) and compare against content_hash.
/// Mismatch → trace is invalid for reputation / dispute / marketplace.
#[account]
pub struct TraceAnchorAccount {
    pub version: u8,
    /// 32-byte task identifier — Blake3(company_pda || routine_id_or_zero
    /// || creation_nonce || creation_slot) per §9.2.
    pub task_id: [u8; 32],
    /// Agent that produced this trace (must match task's registered agent).
    pub agent_address: Pubkey,
    /// Blake3 digest of canonical trace serialization (off-chain content).
    pub content_hash: [u8; 32],
    /// Unix timestamp when commit_trace was accepted on-chain.
    pub completed_at: i64,
    /// Ed25519 signature over (task_id || content_hash || completed_at_le)
    /// produced by the agent's signing key.
    pub agent_signature: [u8; 64],
}

impl TraceAnchorAccount {
    pub const MAX_SIZE: usize = 8 + 1 + 32 + 32 + 32 + 8 + 64;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"trace";
}
