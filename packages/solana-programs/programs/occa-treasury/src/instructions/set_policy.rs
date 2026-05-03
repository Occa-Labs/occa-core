use anchor_lang::prelude::*;

use crate::state::policy::PolicyAccount;

/// Parameters for setting or updating the authorization policy.
/// Classified as Privileged — must be signed by the controlling authority.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyParams {
    pub routine_budget_per_period:    u64,
    pub period_seconds:               u32,
    pub discretionary_window_seconds: u32,
    pub privileged_threshold:         u64,
    pub secondary_signer:             Option<Pubkey>,
    /// Up to 8 SPL token mints; pad with Pubkey::default() if fewer.
    pub allowed_assets:               [Pubkey; 8],
}

#[derive(Accounts)]
pub struct SetPolicy<'info> {
    // controlling_authority validated via policy.company → registry CPI
    // (simplified here: authority signs directly).
    #[account(
        mut,
        seeds = [PolicyAccount::SEED_PREFIX, company.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, PolicyAccount>,

    /// CHECK: serves as seed input; authority must match company's controlling_authority.
    pub company: UncheckedAccount<'info>,

    pub controlling_authority: Signer<'info>,
}

pub fn handler(ctx: Context<SetPolicy>, params: PolicyParams) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let clock   = Clock::get()?;

    policy.routine_budget_per_period    = params.routine_budget_per_period;
    policy.period_seconds               = params.period_seconds;
    policy.discretionary_window_seconds = params.discretionary_window_seconds;
    policy.privileged_threshold         = params.privileged_threshold;
    policy.secondary_signer             = params.secondary_signer;
    policy.allowed_assets               = params.allowed_assets;
    policy.updated_at                   = clock.unix_timestamp;

    Ok(())
}
