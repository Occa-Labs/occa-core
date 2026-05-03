use anchor_lang::prelude::*;

/// Seeds: ["company", controlling_authority, nonce_le_bytes]
/// One PDA per company — serves as identity, ownership boundary, and
/// treasury authority pointer (§5.1.1, §8.2.2).
#[account]
#[derive(Default)]
pub struct CompanyAccount {
    /// Schema version for forward-compatible migrations.
    pub version: u8,
    /// Address permitted to sign Privileged-class instructions.
    /// Mutated only by `transfer_authority`.
    pub controlling_authority: Pubkey,
    /// Associated TreasuryAccount PDA.
    pub treasury: Pubkey,
    /// Associated PolicyAccount PDA (owned by occa-treasury program).
    pub policy: Pubkey,
    /// Creation timestamp (Unix seconds).
    pub created_at: i64,
    /// Pointer to off-chain company metadata (name, description, branding).
    pub metadata_uri: String,
    /// Nonce used as seed component — preserved for PDA re-derivation.
    pub nonce: u64,
}

impl CompanyAccount {
    /// Discriminator (8) + version (1) + authority (32) + treasury (32)
    /// + policy (32) + created_at (8) + nonce (8) + uri (4 + 200 max)
    pub const MAX_SIZE: usize = 8 + 1 + 32 + 32 + 32 + 8 + 8 + (4 + 200);
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"company";
}
