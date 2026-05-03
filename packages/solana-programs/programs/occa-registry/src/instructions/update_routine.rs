use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{routine::RoutineAccount, company::CompanyAccount};

#[derive(Accounts)]
pub struct UpdateRoutine<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(mut, has_one = company)]
    pub routine: Account<'info, RoutineAccount>,

    pub controlling_authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateRoutine>,
    schedule_uri: Option<String>,
    template_uri: Option<String>,
) -> Result<()> {
    let routine = &mut ctx.accounts.routine;

    if let Some(s) = schedule_uri {
        require!(s.len() <= 200, RegistryError::MetadataUriTooLong);
        routine.schedule_uri = s;
    }
    if let Some(t) = template_uri {
        require!(t.len() <= 200, RegistryError::MetadataUriTooLong);
        routine.template_uri = t;
    }
    routine.updated_at = Clock::get()?.unix_timestamp;

    Ok(())
}
