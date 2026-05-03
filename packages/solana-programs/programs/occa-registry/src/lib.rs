use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

// Replace with `anchor keys list` output after first build.
declare_id!("REGy7vRpBRbwBa8BKr5AkJF3p1nqFJFNrSMCX8bR9Ev");

#[program]
pub mod occa_registry {
    use super::*;

    // ── Company ─────────────────────────────────────────────────────
    pub fn create_company(
        ctx: Context<CreateCompany>,
        nonce: u64,
        metadata_uri: String,
    ) -> Result<()> {
        instructions::create_company::handler(ctx, nonce, metadata_uri)
    }

    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::transfer_authority::handler(ctx, new_authority)
    }

    // ── Agent ────────────────────────────────────────────────────────
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_index: u32,
        role_id: u32,
        custody_model: state::agent::CustodyModel,
        adapter_id: Pubkey,
        metadata_uri: String,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, agent_index, role_id, custody_model, adapter_id, metadata_uri)
    }

    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        role_id: Option<u32>,
        adapter_id: Option<Pubkey>,
        metadata_uri: Option<String>,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, role_id, adapter_id, metadata_uri)
    }

    pub fn retire_agent(ctx: Context<RetireAgent>) -> Result<()> {
        instructions::retire_agent::handler(ctx)
    }

    // ── Skill ────────────────────────────────────────────────────────
    pub fn attach_skill(
        ctx: Context<AttachSkill>,
        skill_id: [u8; 32],
        manifest_uri: String,
    ) -> Result<()> {
        instructions::attach_skill::handler(ctx, skill_id, manifest_uri)
    }

    pub fn detach_skill(ctx: Context<DetachSkill>) -> Result<()> {
        instructions::detach_skill::handler(ctx)
    }

    // ── Routine ──────────────────────────────────────────────────────
    pub fn define_routine(
        ctx: Context<DefineRoutine>,
        routine_id: [u8; 32],
        schedule_uri: String,
        template_uri: String,
    ) -> Result<()> {
        instructions::define_routine::handler(ctx, routine_id, schedule_uri, template_uri)
    }

    pub fn update_routine(
        ctx: Context<UpdateRoutine>,
        schedule_uri: Option<String>,
        template_uri: Option<String>,
    ) -> Result<()> {
        instructions::update_routine::handler(ctx, schedule_uri, template_uri)
    }

    pub fn pause_routine(ctx: Context<PauseRoutine>, paused: bool) -> Result<()> {
        instructions::pause_routine::handler(ctx, paused)
    }
}
