use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{agent::{AgentAccount, AgentStatus}, company::CompanyAccount};

#[derive(Accounts)]
pub struct RetireAgent<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(
        mut,
        has_one = company,
        constraint = agent.status != AgentStatus::Retired @ RegistryError::AgentAlreadyRetired,
    )]
    pub agent: Account<'info, AgentAccount>,

    pub controlling_authority: Signer<'info>,
}

pub fn handler(ctx: Context<RetireAgent>) -> Result<()> {
    ctx.accounts.agent.status     = AgentStatus::Retired;
    ctx.accounts.agent.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}
