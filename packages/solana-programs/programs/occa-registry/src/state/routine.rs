use anchor_lang::prelude::*;

/// Seeds: ["routine", company_pda, routine_id]
/// Declared recurring work — fires tasks on schedule (§5.2.3).
#[account]
pub struct RoutineAccount {
    pub version: u8,
    pub company: Pubkey,
    /// 32-byte routine identifier.
    pub routine_id: [u8; 32],
    /// Pointer to off-chain schedule config (cron / heartbeat / event).
    pub schedule_uri: String,
    /// Pointer to off-chain task template used when routine fires.
    pub template_uri: String,
    /// Whether the routine is currently paused.
    pub paused: bool,
    /// Unix timestamp of last successful fire. 0 = never fired.
    pub last_fired_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl RoutineAccount {
    pub const MAX_SIZE: usize =
        8 + 1 + 32 + 32 + (4 + 200) + (4 + 200) + 1 + 8 + 8 + 8;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"routine";
}
