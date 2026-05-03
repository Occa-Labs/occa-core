use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{routine::RoutineAccount, company::CompanyAccount};

#[derive(Accounts)]
#[instruction(routine_id: [u8; 32])]
pub struct DefineRoutine<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(
        init,
        payer = controlling_authority,
        space = RoutineAccount::MAX_SIZE,
        seeds = [RoutineAccount::SEED_PREFIX, company.key().as_ref(), &routine_id],
        bump,
    )]
    pub routine: Account<'info, RoutineAccount>,

    #[account(mut)]
    pub controlling_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<DefineRoutine>,
    routine_id: [u8; 32],
    schedule_uri: String,
    template_uri: String,
) -> Result<()> {
    require!(schedule_uri.len() <= 200, RegistryError::MetadataUriTooLong);
    require!(template_uri.len() <= 200, RegistryError::MetadataUriTooLong);

    let routine      = &mut ctx.accounts.routine;
    let clock        = Clock::get()?;

    routine.version      = RoutineAccount::VERSION;
    routine.company      = ctx.accounts.company.key();
    routine.routine_id   = routine_id;
    routine.schedule_uri = schedule_uri;
    routine.template_uri = template_uri;
    routine.paused       = false;
    routine.last_fired_at = 0;
    routine.created_at   = clock.unix_timestamp;
    routine.updated_at   = clock.unix_timestamp;

    Ok(())
}
