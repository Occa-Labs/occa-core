use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::TreasuryError;
use crate::state::policy::PolicyAccount;

/// Privileged-class disbursement — operator + secondary_signer required
/// when amount exceeds policy.privileged_threshold (§8.4).
#[derive(Accounts)]
pub struct DisbursePrivileged<'info> {
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

    /// Primary controlling authority.
    pub controlling_authority: Signer<'info>,

    /// Secondary signer — required when amount >= policy.privileged_threshold.
    /// Must match policy.secondary_signer.
    pub secondary_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DisbursePrivileged>, amount: u64) -> Result<()> {
    let policy = &ctx.accounts.policy;

    // Validate secondary signer matches policy.
    if let Some(expected) = policy.secondary_signer {
        require!(
            ctx.accounts.secondary_signer.key() == expected,
            TreasuryError::InvalidSecondarySigner
        );
    }

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
