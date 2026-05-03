use anchor_lang::prelude::*;

#[error_code]
pub enum TreasuryError {
    #[msg("Disbursement exceeds the Routine-class per-period budget")]
    BudgetExceeded,
    #[msg("Amount exceeds Privileged-class threshold — secondary signer required")]
    ThresholdNotMet,
    #[msg("Discretionary approval window has expired")]
    ApprovalExpired,
    #[msg("Unauthorized: signer is not the controlling authority")]
    Unauthorized,
    #[msg("Secondary signer does not match policy")]
    InvalidSecondarySigner,
    #[msg("Asset mint is not on the allow-list")]
    AssetNotAllowed,
    #[msg("Insufficient treasury balance")]
    InsufficientBalance,
    #[msg("Period window has not elapsed yet")]
    PeriodNotElapsed,
}
