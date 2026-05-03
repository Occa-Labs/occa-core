use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("TRSqXKJGF9s6wYzwLa3yjNJvuPGRqMV1rHZnmGrjMTt");

#[program]
pub mod occa_treasury {
    use super::*;

    /// Install or update the authorization policy (Privileged class).
    pub fn set_policy(ctx: Context<SetPolicy>, params: instructions::set_policy::PolicyParams) -> Result<()> {
        instructions::set_policy::handler(ctx, params)
    }

    /// Programmatic disbursement within the Routine-class per-period budget.
    /// Used for scheduled agent compensation.
    pub fn disburse_routine(
        ctx: Context<DisburseRoutine>,
        amount: u64,
    ) -> Result<()> {
        instructions::disburse_routine::handler(ctx, amount)
    }

    /// Single operator-signed disbursement (Discretionary class).
    pub fn disburse_discretionary(
        ctx: Context<DisburseDiscretionary>,
        amount: u64,
    ) -> Result<()> {
        instructions::disburse_discretionary::handler(ctx, amount)
    }

    /// Privileged-class transfer — requires secondary signer above threshold.
    pub fn disburse_privileged(
        ctx: Context<DisbursePrivileged>,
        amount: u64,
    ) -> Result<()> {
        instructions::disburse_privileged::handler(ctx, amount)
    }
}
