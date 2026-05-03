use anchor_lang::prelude::*;

use crate::errors::RegistryError;
use crate::state::{skill::SkillAccount, company::CompanyAccount};

#[derive(Accounts)]
#[instruction(skill_id: [u8; 32])]
pub struct AttachSkill<'info> {
    #[account(has_one = controlling_authority @ RegistryError::Unauthorized)]
    pub company: Account<'info, CompanyAccount>,

    #[account(
        init,
        payer = controlling_authority,
        space = SkillAccount::MAX_SIZE,
        seeds = [SkillAccount::SEED_PREFIX, company.key().as_ref(), &skill_id],
        bump,
    )]
    pub skill: Account<'info, SkillAccount>,

    #[account(mut)]
    pub controlling_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<AttachSkill>,
    skill_id: [u8; 32],
    manifest_uri: String,
) -> Result<()> {
    require!(manifest_uri.len() <= 200, RegistryError::MetadataUriTooLong);

    let skill = &mut ctx.accounts.skill;
    skill.version      = SkillAccount::VERSION;
    skill.company      = ctx.accounts.company.key();
    skill.agent        = Pubkey::default(); // caller sets target agent
    skill.skill_id     = skill_id;
    skill.manifest_uri = manifest_uri;
    skill.attached_at  = Clock::get()?.unix_timestamp;

    Ok(())
}
