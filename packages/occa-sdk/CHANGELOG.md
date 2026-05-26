# Changelog

All notable changes to `occa-sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-05-26

Phase 1 close-out coverage. SDK now exposes the full Treasury operations
lifecycle, the autonomous routine payout path, the over-threshold
privileged payout path, and the daily anchor commit used by the Registry
audit trail. `SetPolicy` gains the second-signer / threshold fields that
back the privileged disbursement class.

No breaking changes — all additions. Existing `buildSetPolicyInstruction`
callers keep working: the new `secondarySigner` and `privilegedThreshold`
params default to "no change" when omitted.

### Added

#### Treasury — operations lifecycle
Operations accounts hold the per-company signer-capability metadata
(Disbursement vs Anchor). Both kinds share the same lifecycle builders:

- `buildRegisterCompanyOperationsInstruction(...)`
- `buildUpdateOperationsCapabilityInstruction(...)`
- `buildRevokeOperationsInstruction(...)`
- `buildCloseOperationsInstruction(...)`
- `OPERATIONS_KIND` enum (`Disbursement` | `Anchor`) + `OperationsKind` type
- `deriveOperationsPda(companyPda, kind)`

#### Treasury — payouts
- `buildDisburseRoutineInstruction(...)` — flagship autonomous payout
  signed by the registered Disbursement Wallet; settles within the
  per-month routine budget set by `SetPolicy`
- `buildDisbursePrivilegedInstruction(...)` — over-threshold disbursement
  requiring controlling authority + Disbursement Wallet co-signature

#### Treasury — protocol fees
- `buildInitProtocolFeeAccountInstruction(...)` — one-time singleton
  initializer for the protocol fee collection PDA

#### Registry — daily anchor
- `buildCommitDailyAnchorInstruction(...)` — commit a per-deployment
  per-UTC-day Merkle root of canonical trace bytes
- `deriveDailyAnchorPda(deploymentPda, dayIndex)`
- `DailyAnchorAccount` entry in `ACCOUNT_DISCRIMINATOR`

### Changed

- **`buildSetPolicyInstruction`** params extended with optional
  `secondarySigner` (three-valued: `undefined` = no change, `null` =
  clear, `PublicKey` = set), `privilegedThresholdLamports` (`bigint`),
  and `privilegedThresholdPerToken` (`AssetBudget[]`). Existing calls
  compile and behave identically — the previous hard-coded `None` is
  now the default when these are omitted.
- **Treasury IDL** synced to the redeployed program covering the new
  operations + privileged disbursement instructions and accounts.
- **`devnet-smoke`** script updated for the prior
  `set_operating_wallet` → `set_receiving_address` rename.

## [0.3.0] - 2026-05-16

Treasury program support. The SDK now covers the **Treasury program** in
addition to Registry — set spending policy and disburse funds to agents
on-chain. Also aligns `create_company` + the receiving-address setter
with the latest deployed program account layouts.

### ⚠️ Breaking Changes

- **Renamed** `buildSetOperatingWalletInstruction` → `buildSetReceivingAddressInstruction`,
  `SetOperatingWalletParams` → `SetReceivingAddressParams`, and the param
  field `newOperatingWallet` → `newReceivingAddress`. The on-chain
  instruction was renamed `set_operating_wallet` → `set_receiving_address`;
  the old discriminator is rejected by the deployed program.
- **`buildCreateCompanyInstruction`** now appends the `treasury`, `policy`,
  and `treasury_program` accounts the redeployed `create_company` requires
  (it CPIs into `treasury::init_treasury`). Its return value gains
  `treasuryPda` and `policyPda`. Callers passing a hand-built account list
  must adopt the builder.

### Added

#### Treasury program
- `buildSetPolicyInstruction(...)` — set per-month routine / discretionary
  budgets, accepted assets, and the Agent Operating Fee
- `buildDisburseDiscretionaryInstruction(...)` — controlling-authority
  payout to an agent's receiving address; 3% fee deducted on-chain
- `deriveTreasuryPda(companyPda)`, `derivePolicyPda(companyPda)`,
  `deriveProtocolFeePda()`
- `TREASURY_INSTRUCTION_DISCRIMINATOR`, `TREASURY_ACCOUNT_DISCRIMINATOR`
- `TREASURY_PROGRAM_ID` / `TREASURY_PROGRAM_ID_BASE58`
- `SOL_PSEUDO_MINT` — the all-zero pubkey marker for native SOL
- Seeds `TREASURY_SEED`, `POLICY_SEED`, `PROTOCOL_FEES_SEED`
- `AssetBudget` type — `{ mint, amount }` per-asset budget entry

### Migration guide (v0.2.x → v0.3.0)

```ts
// Before
import { buildSetOperatingWalletInstruction } from "occa-sdk";
buildSetOperatingWalletInstruction({ deploymentPda, owner, newOperatingWallet });

// After
import { buildSetReceivingAddressInstruction } from "occa-sdk";
buildSetReceivingAddressInstruction({ deploymentPda, owner, newReceivingAddress });
```

`buildCreateCompanyInstruction` callers: no code change needed if you use
the returned `instruction` directly — the extra accounts are added
internally. Stop hand-assembling the account list.

## [0.2.1] - 2026-05-07

Devnet program redeploy. No API changes — consumers only need to refresh the bundled IDL/program ID.

### Changed

- **Devnet `REGISTRY_PROGRAM_ID`** rotated to `occaTHMv5eYG5aZ85jimxTvHkBfsDCvndXC6J2k8kxr` after a fresh Registry redeploy. IDL `address` field updated to match.

## [0.2.0] - 2026-05-06

Sync to OCCA Registry program v3. Introduces the **Deployment** primitive — Agent is now a standalone on-chain identity (`AgentIdentity`) bound to a Company through a separate `Deployment` PDA, replacing the v0.1.0 model where agents were directly company-scoped.

### ⚠️ Breaking Changes

- **Removed** `buildRegisterAgentInstruction` / `RegisterAgentParams`. Agent registration is now a two-step flow: call `buildRegisterAgentIdentityInstruction` to create the agent, then `buildCreateDeploymentInstruction` to bind it to a company.
- **Removed** `deriveAgentPda(companyPda, agentIndex)`. Use `deriveAgentIdentityPda(agentPubkey)` for the agent's identity PDA, and `deriveDeploymentPda(companyPda, deploymentIndex)` for the company-agent binding PDA.
- **Removed** custody model concepts:
  - `CUSTODY_MODEL`, `CUSTODY_MODEL_ON_CHAIN`
  - `custodyModelStringToU8()`
  - `CURRENT_DERIVATION_MSG_VERSION`
  - These responsibilities moved out of the SDK; custody is now handled at the runtime layer.
- **Renamed** seed constant `AGENT_SEED` → `AGENT_IDENTITY_SEED`. New seed `DEPLOYMENT_SEED` added.
- **Removed** `src/derivation.ts`. Its responsibilities split into `src/pda.ts` (PDA helpers) and `src/instructions.ts` (instruction builders).
- **Removed dependency** `@noble/hashes` — no longer needed after custody model removal. SDK now only depends on `@solana/web3.js`.

### Added

#### AgentIdentity primitive
- `buildRegisterAgentIdentityInstruction(...)` — create a standalone on-chain agent identity
- `buildUpdateAgentIdentityMetadataInstruction(...)` — update agent metadata
- `deriveAgentIdentityPda(agentPubkey)` — derive the AgentIdentity PDA

#### Deployment primitive (NEW concept)
- `buildCreateDeploymentInstruction(...)` — bind an AgentIdentity to a Company
- `buildUpdateDeploymentMetadataInstruction(...)`
- `buildUpdateDeploymentStatusInstruction(...)`
- `buildRetireDeploymentInstruction(...)`
- `deriveDeploymentPda(companyPda, deploymentIndex)`

#### Company management
- `buildUpdateCompanyMetadataInstruction(...)`
- `buildUpdateCompanyStatusInstruction(...)`

#### Operational
- `buildSetOperatingWalletInstruction(...)` — assign an operating wallet to a deployment

#### Constants & types
- `INSTRUCTION_DISCRIMINATOR` — map of all 10 instruction discriminators
- `COMPANY_STATUS` enum + `CompanyStatus` type
- `DEPLOYMENT_STATUS` enum + `DeploymentStatus` type
- Length bounds: `MAX_NAME_LEN`, `MAX_LOCALE_LEN`, `MAX_ROLE_LEN`, `MAX_METADATA_URI_LEN`, `MAX_REPUTATION_URI_LEN`
- New seeds: `AGENT_IDENTITY_SEED`, `DEPLOYMENT_SEED`

### Changed

- **IDL** refreshed to cover all 10 Registry v3 instructions and 3 account types (CompanyAccount, AgentIdentity, Deployment).
- **Devnet smoke script** rewritten to exercise the new register-identity → create-deployment flow.
- **tsup config** updated for new module entrypoints.

### Migration guide (v0.1.0 → v0.2.0)

**Before (v0.1.0):**
```ts
import { buildRegisterAgentInstruction, deriveAgentPda } from "occa-sdk";

const [agentPda] = deriveAgentPda(companyPda, agentIndex);
const ix = buildRegisterAgentInstruction({
  companyPda,
  owner,
  payer,
  agentIndex,
  roleId,
  adapterId,
});
```

**After (v0.2.0):**
```ts
import {
  buildRegisterAgentIdentityInstruction,
  buildCreateDeploymentInstruction,
  deriveAgentIdentityPda,
  deriveDeploymentPda,
} from "occa-sdk";

// Step 1 — register the standalone agent identity
const [identityPda] = deriveAgentIdentityPda(agentPubkey);
const registerIx = buildRegisterAgentIdentityInstruction({
  agentPubkey,
  owner,
  payer,
  name,
  metadataUri,
  metadataHash,
});

// Step 2 — bind the agent to a company via a Deployment
const [deploymentPda] = deriveDeploymentPda(companyPda, deploymentIndex);
const deployIx = buildCreateDeploymentInstruction({
  companyPda,
  identityPda,
  deploymentIndex,
  /* ...role, status, metadata */
});
```

## [0.1.0] - 2026-05-05

Initial release. Provided PDA helpers, instruction builders, and types for the OCCA Registry program v1.

### Added

- `buildCreateCompanyInstruction(...)` — create a Company PDA
- `buildRegisterAgentInstruction(...)` — register an agent directly under a company
- `deriveCompanyPda(owner, nonce)`
- `deriveAgentPda(companyPda, agentIndex)`
- Sign-to-derive custody model with `CUSTODY_MODEL` enum and helpers
- Initial IDL bundle for Registry program v1
- Devnet smoke script

[0.4.0]: https://github.com/Occa-Labs/occa-core/compare/occa-sdk@0.3.0...occa-sdk@0.4.0
[0.3.0]: https://github.com/Occa-Labs/occa-core/compare/occa-sdk@0.2.1...occa-sdk@0.3.0
[0.2.1]: https://github.com/Occa-Labs/occa-core/compare/occa-sdk@0.2.0...occa-sdk@0.2.1
[0.2.0]: https://github.com/Occa-Labs/occa-core/compare/occa-sdk@0.1.0...occa-sdk@0.2.0
[0.1.0]: https://github.com/Occa-Labs/occa-core/releases/tag/occa-sdk@0.1.0
