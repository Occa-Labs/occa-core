use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::TreasuryError;
use crate::state::policy::PolicyAccount;

/// Routine-class disbursement — programmatic, within per-period budget.
/// Used for scheduled agent compensation transfers (§8.4).
#[derive(Accounts)]
pub struct DisburseRoutine<'info> {
    #[account(
        mut,
        seeds = [PolicyAccount::SEED_PREFIX, treasury.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, PolicyAccount>,

    /// Treasury PDA — source of funds.
    /// CHECK: validated by seeds; program signs via PDA bump.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    /// Destination — typically an agent wallet address.
    /// CHECK: caller responsibility to validate destination.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DisburseRoutine>, amount: u64) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let clock   = Clock::get()?;

    // Reset period if elapsed.
    if clock.unix_timestamp >= policy.period_start + policy.period_seconds as i64 {
        policy.period_spent = 0;
        policy.period_start = clock.unix_timestamp;
    }

    let new_spent = policy.period_spent.checked_add(amount)
        .ok_or(TreasuryError::BudgetExceeded)?;

    require!(new_spent <= policy.routine_budget_per_period, TreasuryError::BudgetExceeded);

    policy.period_spent = new_spent;

    // SOL transfer via CPI — treasury is a PDA so we use invoke_signed.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to:   ctx.accounts.destination.to_account_info(),
            },
        ),
        amount,
    )?;

    Ok(())
}
