use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{skill::SkillAccount, company::CompanyAccount};

#[derive(Accounts)]
pub struct DetachSkill<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(
        mut,
        has_one = company,
        close = controlling_authority,
    )]
    pub skill: Account<'info, SkillAccount>,

    #[account(mut)]
    pub controlling_authority: Signer<'info>,
}

pub fn handler(_ctx: Context<DetachSkill>) -> Result<()> {
    // Account is closed via `close = controlling_authority` constraint;
    // rent reclaimed to authority.
    Ok(())
}
