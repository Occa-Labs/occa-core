use anchor_lang::prelude::*;

/// Seeds: ["skill", company_pda, skill_id]
/// Per-agent skill attachment record (§5.1.6).
#[account]
pub struct SkillAccount {
    pub version: u8,
    pub company: Pubkey,
    pub agent: Pubkey,
    /// 32-byte skill identifier (Blake3 of canonical skill locator).
    pub skill_id: [u8; 32],
    /// Pointer to off-chain skill manifest (SKILL.md + file inventory).
    pub manifest_uri: String,
    pub attached_at: i64,
}

impl SkillAccount {
    pub const MAX_SIZE: usize = 8 + 1 + 32 + 32 + 32 + (4 + 200) + 8;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"skill";
}
