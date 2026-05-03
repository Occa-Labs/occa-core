use anchor_lang::prelude::*;

#[error_code]
pub enum TraceAnchorError {
    #[msg("Agent signature does not match the registered agent address for this task")]
    InvalidAgentSignature,
    #[msg("task_id in instruction does not match account seeds")]
    TaskMismatch,
    #[msg("Trace anchor already committed for this task")]
    AlreadyCommitted,
    #[msg("Content hash cannot be all-zeros")]
    InvalidContentHash,
}
