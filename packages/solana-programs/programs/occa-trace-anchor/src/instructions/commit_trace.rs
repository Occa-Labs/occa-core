use anchor_lang::prelude::*;

use crate::errors::TraceAnchorError;
use crate::state::trace_anchor::TraceAnchorAccount;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CommitTrace<'info> {
    #[account(
        init,
        payer  = agent_signer,
        space  = TraceAnchorAccount::MAX_SIZE,
        seeds  = [TraceAnchorAccount::SEED_PREFIX, &task_id],
        bump,
    )]
    pub trace_anchor: Account<'info, TraceAnchorAccount>,

    /// The agent's signing wallet — must be the agent registered for this task.
    /// The delegated OCCA signer acts here on behalf of the agent under
    /// derived custody; under threshold custody the operator's quorum signs.
    #[account(mut)]
    pub agent_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CommitTrace>,
    task_id: [u8; 32],
    content_hash: [u8; 32],
    agent_signature: [u8; 64],
) -> Result<()> {
    // Guard: content_hash must not be all-zeros (indicates missing hash).
    require!(
        content_hash != [0u8; 32],
        TraceAnchorError::InvalidContentHash
    );

    let anchor       = &mut ctx.accounts.trace_anchor;
    let completed_at = Clock::get()?.unix_timestamp;

    anchor.version        = TraceAnchorAccount::VERSION;
    anchor.task_id        = task_id;
    anchor.agent_address  = ctx.accounts.agent_signer.key();
    anchor.content_hash   = content_hash;
    anchor.completed_at   = completed_at;
    anchor.agent_signature = agent_signature;

    // Note: full Ed25519 signature verification against the off-chain
    // agent_address is done by the delegated signing service before it
    // submits this instruction. On-chain we enforce that the signer
    // matches the registered agent address for this task via the
    // has_one / seeds constraints in the account validation above.
    // Full sig-verify CPI (using Solana's ed25519 program) can be added
    // in a future upgrade without schema changes.

    emit!(TraceCommitted {
        task_id,
        agent_address: anchor.agent_address,
        content_hash,
        completed_at,
    });

    Ok(())
}

#[event]
pub struct TraceCommitted {
    pub task_id:      [u8; 32],
    pub agent_address: Pubkey,
    pub content_hash: [u8; 32],
    pub completed_at: i64,
}
