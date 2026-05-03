use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{routine::RoutineAccount, company::CompanyAccount};

#[derive(Accounts)]
pub struct PauseRoutine<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(mut, has_one = company)]
    pub routine: Account<'info, RoutineAccount>,

    pub controlling_authority: Signer<'info>,
}

pub fn handler(ctx: Context<PauseRoutine>, paused: bool) -> Result<()> {
    ctx.accounts.routine.paused     = paused;
    ctx.accounts.routine.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
