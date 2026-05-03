use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{agent::{AgentAccount, AgentStatus, CustodyModel}, company::CompanyAccount};

#[derive(Accounts)]
#[instruction(agent_index: u32)]
pub struct RegisterAgent<'info> {
    #[account(
        has_one = controlling_authority @ RegistryError::Unauthorized,
    )]
    pub company: Account<'info, CompanyAccount>,

    #[account(
        init,
        payer  = controlling_authority,
        space  = AgentAccount::MAX_SIZE,
        seeds  = [
            AgentAccount::SEED_PREFIX,
            company.key().as_ref(),
            &agent_index.to_le_bytes(),
        ],
        bump,
    )]
    pub agent: Account<'info, AgentAccount>,

    #[account(mut)]
    pub controlling_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_index: u32,
    role_id: u32,
    custody_model: CustodyModel,
    adapter_id: Pubkey,
    metadata_uri: String,
) -> Result<()> {
    require!(
        metadata_uri.len() <= 200,
        RegistryError::MetadataUriTooLong
    );

    let agent = &mut ctx.accounts.agent;
    let clock  = Clock::get()?;

    agent.version          = AgentAccount::VERSION;
    agent.company          = ctx.accounts.company.key();
    agent.agent_address    = Pubkey::default(); // set by operator after key derivation
    agent.custody_model    = custody_model;
    agent.derivation_index = agent_index;
    agent.role_id          = role_id;
    agent.adapter_id       = adapter_id;
    agent.status           = AgentStatus::Active;
    agent.metadata_uri     = metadata_uri;
    agent.agent_index      = agent_index;
    agent.created_at       = clock.unix_timestamp;
    agent.updated_at       = clock.unix_timestamp;

    Ok(())
}
