use anchor_lang::prelude::*;

/// Seeds: ["policy", company_pda]
/// Authorization policy gating treasury outflows (§8.4).
///
/// Three disbursement classes:
///   Routine      — programmatic, within per-period budget
///   Discretionary — single operator sig, time-bounded
///   Privileged   — operator + secondary_signer above threshold
#[account]
pub struct PolicyAccount {
    pub version: u8,
    pub company: Pubkey,

    // ── Routine class ────────────────────────────────────────────────
    /// Maximum total Routine-class disbursement per period (in lamports or
    /// token base units — currency resolved at call time by the instruction).
    pub routine_budget_per_period: u64,
    /// Length of the budget period in seconds.
    pub period_seconds: u32,
    /// Accumulated Routine disbursements in the current period.
    pub period_spent: u64,
    /// Start of the current period (Unix seconds).
    pub period_start: i64,

    // ── Discretionary class ──────────────────────────────────────────
    /// How long (seconds) a Discretionary approval signature remains valid.
    pub discretionary_window_seconds: u32,

    // ── Privileged class ─────────────────────────────────────────────
    /// Amount (lamports / base units) above which secondary_signer is required.
    pub privileged_threshold: u64,
    /// Required co-signer for Privileged disbursements above threshold.
    pub secondary_signer: Option<Pubkey>,

    // ── Asset allow-list ─────────────────────────────────────────────
    /// SPL token mints accepted by this treasury (max 8 entries).
    /// Empty slot = Pubkey::default() (ignored).
    pub allowed_assets: [Pubkey; 8],

    pub updated_at: i64,
}

impl PolicyAccount {
    pub const MAX_SIZE: usize =
        8 + 1 + 32 + 8 + 4 + 8 + 8 + 4 + 8 + (1 + 32) + (32 * 8) + 8;
    pub const VERSION: u8 = 1;
    pub const SEED_PREFIX: &'static [u8] = b"policy";
}
