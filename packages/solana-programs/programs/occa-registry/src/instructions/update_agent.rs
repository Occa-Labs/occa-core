use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{agent::{AgentAccount, AgentStatus}, company::CompanyAccount};

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
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

pub fn handler(
    ctx: Context<UpdateAgent>,
    role_id: Option<u32>,
    adapter_id: Option<Pubkey>,
    metadata_uri: Option<String>,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    let clock  = Clock::get()?;

    if let Some(r) = role_id { agent.role_id = r; }
    if let Some(a) = adapter_id { agent.adapter_id = a; }
    if let Some(m) = metadata_uri {
        require!(m.len() <= 200, RegistryError::MetadataUriTooLong);
        agent.metadata_uri = m;
    }
    agent.updated_at = clock.unix_timestamp;

    Ok(())
}
