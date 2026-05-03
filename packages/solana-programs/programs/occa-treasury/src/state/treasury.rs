use anchor_lang::prelude::*;

/// Seeds: ["treasury", company_pda]
/// Holds SOL directly and acts as authority for associated SPL token accounts.
/// No custom token standard — composes with standard Solana wallets & explorers (§9.5).
#[account]
pub struct TreasuryAccount {
    pub version: u8,
    /// Owning company PDA (from occa-registry).
    pub company: Pubkey,
    /// Bump for this PDA — stored for CPI signing.
    pub bump: u8,
    pub created_at: i64,
}

impl TreasuryAccount {
    pub const MAX_SIZE: usize = 8 + 1 + 32 + 1 + 8;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"treasury";
}
