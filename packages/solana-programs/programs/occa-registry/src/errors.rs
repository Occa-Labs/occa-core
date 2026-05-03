use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Metadata URI exceeds maximum length")]
    MetadataUriTooLong,
    #[msg("Unauthorized: signer is not the controlling authority")]
    Unauthorized,
    #[msg("Agent derivation index already in use")]
    AgentIndexConflict,
    #[msg("Agent is already retired")]
    AgentAlreadyRetired,
    #[msg("Skill is already attached to this agent")]
    SkillAlreadyAttached,
    #[msg("Routine ID already exists for this company")]
    RoutineAlreadyExists,
    #[msg("Company creation fee transfer failed")]
    FeeTransferFailed,
}
