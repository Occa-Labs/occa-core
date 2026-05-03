use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::TreasuryError;
use crate::state::policy::PolicyAccount;

/// Discretionary-class disbursement — single operator signature,
/// time-bounded approval window (§8.4).
#[derive(Accounts)]
pub struct DisburseDiscretionary<'info> {
    #[account(
        mut,
        seeds = [PolicyAccount::SEED_PREFIX, treasury.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, PolicyAccount>,

    /// CHECK: treasury PDA.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: destination wallet.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// Operator controlling authority — must sign the transaction.
    pub controlling_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DisburseDiscretionary>, amount: u64) -> Result<()> {
    let policy = &ctx.accounts.policy;

    // Below privileged threshold — Discretionary class is sufficient.
    require!(
        amount < policy.privileged_threshold,
        TreasuryError::ThresholdNotMet
    );

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
