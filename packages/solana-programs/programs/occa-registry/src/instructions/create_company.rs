use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RegistryError;
use crate::state::company::CompanyAccount;

/// Company creation fee in lamports (0.25 SOL per whitepaper §11.2).
/// Collected by Registry Program into the Protocol Fee Account.
pub const COMPANY_CREATION_FEE_LAMPORTS: u64 = 250_000_000;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateCompany<'info> {
    #[account(
        init,
        payer  = authority,
        space  = CompanyAccount::MAX_SIZE,
        seeds  = [
            CompanyAccount::SEED_PREFIX,
            authority.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub company: Account<'info, CompanyAccount>,

    /// Controlling authority — the wallet that creates and will own the company.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Protocol Fee Account — receives the creation fee.
    /// CHECK: validated by seeds constraint below.
    #[account(
        mut,
        seeds = [b"protocol_fees"],
        bump,
    )]
    pub protocol_fee_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateCompany>,
    nonce: u64,
    metadata_uri: String,
) -> Result<()> {
    require!(
        metadata_uri.len() <= 200,
        RegistryError::MetadataUriTooLong
    );

    // Transfer creation fee to Protocol Fee Account.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to:   ctx.accounts.protocol_fee_account.to_account_info(),
            },
        ),
        COMPANY_CREATION_FEE_LAMPORTS,
    )?;

    let company = &mut ctx.accounts.company;
    let clock   = Clock::get()?;

    company.version               = CompanyAccount::VERSION;
    company.controlling_authority = ctx.accounts.authority.key();
    // treasury and policy PDAs are derived by occa-treasury; stored here
    // after that program initialises them in the same transaction.
    // For now we leave them as default (zero) — set via update after init.
    company.treasury              = Pubkey::default();
    company.policy                = Pubkey::default();
    company.created_at            = clock.unix_timestamp;
    company.metadata_uri          = metadata_uri;
    company.nonce                 = nonce;

    Ok(())
}
