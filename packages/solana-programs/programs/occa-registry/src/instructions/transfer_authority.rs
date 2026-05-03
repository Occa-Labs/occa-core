use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::company::CompanyAccount;

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(
        mut,
        has_one = controlling_authority @ RegistryError::Unauthorized,
    )]
    pub company: Account<'info, CompanyAccount>,

    pub controlling_authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<TransferAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    ctx.accounts.company.controlling_authority = new_authority;
    Ok(())
}
