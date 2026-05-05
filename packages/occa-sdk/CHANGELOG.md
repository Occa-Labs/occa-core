# Changelog

All notable changes to `occa-sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/Occa-Labs/occa-core/compare/occa-sdk@0.1.0...occa-sdk@0.2.0
[0.1.0]: https://github.com/Occa-Labs/occa-core/releases/tag/occa-sdk@0.1.0
