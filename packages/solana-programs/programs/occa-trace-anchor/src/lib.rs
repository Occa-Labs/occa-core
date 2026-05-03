use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("TRCdummy11111111111111111111111111111111111");

#[program]
pub mod occa_trace_anchor {
    use super::*;

    /// Commit a Blake3 content hash of a completed task trace on-chain.
    /// Signed by the agent's wallet address — the OCCA program rejects
    /// commits whose signature does not match the agent registered for
    /// the originating task (§8.3, §9.3).
    pub fn commit_trace(
        ctx: Context<CommitTrace>,
        task_id: [u8; 32],
        content_hash: [u8; 32],
        agent_signature: [u8; 64],
    ) -> Result<()> {
        instructions::commit_trace::handler(ctx, task_id, content_hash, agent_signature)
    }
}
