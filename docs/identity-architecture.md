# OCCA On-Chain Identity Architecture

> **Source of truth:** Whitepaper §8.2 (Identity & Key Custody), §8.3 (Trace Integrity), §9.1–9.3 (Program & Account Model), Appendix A (Account Schema Summary). This document is an implementation elaboration of that spec — **not** a replacement for it.

## Overview

OCCA separates **identity** (who) from **wallet** (signing key) for both companies and agents:

1. **Identity Layer** — Solana PDA, canonical, permanent — holds metadata + pointers
2. **Wallet Layer** — keypair (or MPC threshold) that can rotate without losing identity

Every persistent entity in OCCA lives as a PDA derived from a deterministic seed (Whitepaper §9.2).

---

## Analogy

```
Real World (US Corporate)            OCCA On-Chain
─────────────────────────────────    ──────────────────────────────────
Delaware C-Corp / LLC             →  CompanyAccount PDA
  EIN / Entity ID (immutable)     →    seeds: ["company", authority, nonce]
  Board / CEO (replaceable)       →    controlling_authority: Pubkey
  Corporate bank account          →    TreasuryAccount PDA (separate)
  Bylaws / spending policy        →    PolicyAccount PDA

Employee / Contractor             →  AgentAccount PDA
  Employee ID (stays with you)    →    seeds: ["agent", company_pda, agent_index]
  Performance record              →    Reputation Program (read-only views)
  Payroll / direct-deposit acct   →    agent_address: Pubkey (signing wallet)
```

Key insight: just as an EIN doesn't change when a CEO is replaced, a `CompanyAccount` PDA address never changes when its `controlling_authority` rotates. Likewise, an Employee ID stays with a worker even if they switch direct-deposit banks — the `AgentAccount` PDA persists across `agent_address` rotations.

---

## Multi-Program Architecture

OCCA is not a single program. Whitepaper §9.1 defines 5 programs deployed under a single program authority:

| Program                  | Responsibility                                |
| ------------------------ | --------------------------------------------- |
| **Registry Program**     | Company, agent, role, skill registrations     |
| **Treasury Program**     | Company treasuries & authorization policies   |
| **Trace Anchor Program** | Receives and stores trace content hashes      |
| **Marketplace Program**  | Labor Market contracts & Template Marketplace |
| **Reputation Program**   | Read-only views over data from other programs |

This partitioning lets each program evolve independently without forcing simultaneous redeployment.

### Account Ownership

```
  Registry Program ──owns──┬──▶ CompanyAccount
                           ├──▶ AgentAccount
                           ├──▶ SkillAccount
                           └──▶ RoutineAccount

  Treasury Program ──owns──┬──▶ TreasuryAccount
                           └──▶ PolicyAccount

  Trace Anchor    ──owns──── ▶ TraceAnchorAccount

  Marketplace     ──owns──┬──▶ ContractAccount
                           ├──▶ ListingAccount
                           └──▶ LicenseAccount

  Reputation      ──reads only──▶ AgentAccount
                  ──reads only──▶ TraceAnchorAccount
                  ──reads only──▶ ContractAccount
```

---

## Account Schemas

All schemas below match **Whitepaper Appendix A** exactly. Field types use Borsh notation. Anchor accounts include an **8-byte discriminator** prefix that is omitted from the tables.

### CompanyAccount (Registry Program)

**Seeds:** `["company", controlling_authority, nonce]`

The `nonce` allows a single controlling_authority to create multiple companies.

| Field                   | Type     | Notes                                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------- |
| `version`               | `u8`     | Schema version                                                                |
| `controlling_authority` | `Pubkey` | Authority for Privileged-class instructions. Updated via `transfer_authority` |
| `treasury`              | `Pubkey` | Pointer to `TreasuryAccount` PDA                                              |
| `policy`                | `Pubkey` | Pointer to `PolicyAccount` PDA                                                |
| `created_at`            | `i64`    | Unix timestamp                                                                |
| `metadata_uri`          | `String` | Off-chain metadata pointer (name, branding)                                   |

**Notes:**

- The company identity _is_ the PDA address itself — no redundant `canonical_id` field needed
- `controlling_authority` may be an EOA, multi-sig, or governance contract
- No `agent_count` field — agent enumeration uses an off-chain index or `getProgramAccounts`

---

### AgentAccount (Registry Program)

**Seeds:** `["agent", company_pda, agent_index]`

`agent_index` is a `u32` per-company counter (not a UUID) — fixed by the whitepaper.

| Field              | Type     | Notes                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `version`          | `u8`     | Schema version                                                                  |
| `company`          | `Pubkey` | Pointer to `CompanyAccount` PDA                                                 |
| `agent_address`    | `Pubkey` | Signing address (SLIP-0010 derived / MPC / custodial)                           |
| `custody_model`    | `enum`   | `Derived` \| `Custodial` \| `Threshold`                                         |
| `derivation_index` | `u32`    | Hardened path index, used when `custody_model = Derived`; rotated on compromise |
| `role_id`          | `u32`    | Reference to role catalog                                                       |
| `adapter_id`       | `Pubkey` | Pinned adapter version                                                          |
| `status`           | `enum`   | `Active` \| `Degraded` \| `Retired`                                             |

**Reputation is not stored here.** The Reputation Program (read-only) derives reputation from `TraceAnchorAccount`, `ContractAccount`, and template sales records.

---

### TreasuryAccount (Treasury Program)

**Seeds:** `["treasury", company_pda]`

Separating from `CompanyAccount` ensures company funds cannot be unilaterally drained by a change in authority. Holds SOL and acts as the authority for the company's associated SPL token accounts.

---

### PolicyAccount (Treasury Program)

**Seeds:** `["policy", company_pda]`

Authorization policy for the treasury (Whitepaper §8.4).

| Field                          | Type             | Notes                                                |
| ------------------------------ | ---------------- | ---------------------------------------------------- |
| `version`                      | `u8`             |                                                      |
| `routine_budget_per_period`    | `u64`            | Max Routine-class disbursement per period            |
| `period_seconds`               | `u32`            | Length of the budget period                          |
| `discretionary_window_seconds` | `u32`            | Validity window for a Discretionary-class signature  |
| `privileged_threshold`         | `u64`            | Threshold above which a secondary signer is required |
| `secondary_signer`             | `Option<Pubkey>` | Secondary signer for Privileged-class instructions   |
| `allowed_assets`               | `Vec<Pubkey>`    | SPL token mints accepted by the treasury             |

---

### TraceAnchorAccount (Trace Anchor Program)

**Seeds:** `["trace", task_id]`

Each completed task → one on-chain PDA. This is durable state, not just a transaction log.

| Field           | Type       | Notes                                                        |
| --------------- | ---------- | ------------------------------------------------------------ |
| `version`       | `u8`       |                                                              |
| `task_id`       | `[u8; 32]` | Hash of task creation parameters                             |
| `agent_address` | `Pubkey`   | Agent that produced the trace                                |
| `content_hash`  | `[u8; 32]` | Blake3 digest of the canonical trace serialization           |
| `completed_at`  | `i64`      | Unix timestamp                                               |
| `signature`     | `[u8; 64]` | Agent signature over `(task_id, content_hash, completed_at)` |

**`task_id` derivation:**

```
task_id = Blake3(company_pda || routine_id_or_zero || creation_nonce || creation_slot)
```

This guarantees global uniqueness without a centralized counter.

---

## Wallet Derivation (SLIP-0010, Default Custody)

When `custody_model = Derived`, the agent wallet is derived deterministically from the operator's master seed using a hardened SLIP-0010 path over Ed25519.

**Solana standard path** (per Phantom/Solflare convention):

```
m / 44' / 501' / <account>' / 0'
```

In OCCA, `<account>'` is populated from `AgentAccount.derivation_index`. The company-to-account-index mapping is maintained off-chain by the operator.

**SLIP-0010 + Ed25519 properties:**

- ONLY hardened derivation (`i ≥ 2³¹`) — public child derivation is **not supported** for Ed25519
- Master: `I = HMAC-SHA512(key="ed25519 seed", data=seed_bytes)`, `(IL, IR) = (I[:32], I[32:])`, private key = IL, chain code = IR
- Child: `I = HMAC-SHA512(key=cpar, data=0x00 || kpar || ser32(i))`

**Recovery:** with the master seed + on-chain `derivation_index`, the keypair is fully recoverable.

---

## Key Rotation Flow

When compromise is detected or rotation is scheduled:

1. Increment `AgentAccount.derivation_index`
2. Derive new keypair with SLIP-0010 at the new index
3. Submit `update_agent` (Registry Program) — signed by `controlling_authority`:
   - Update `agent_address` to the new pubkey
   - Update `derivation_index`
4. Re-delegate the trace-anchor signer to the new address
5. Old address: retired (status update)

**Note from Whitepaper §8.2.3:**

> In-flight payments to a retired address are not automatically forwarded; operators are advised to confirm that pending Labor Market milestones and similar outstanding obligations are settled before initiating rotation.

Reputation continuity is preserved because the **`AgentAccount` PDA address does not change** — only the `agent_address` field inside it.

---

## Custody Models

### Decision Tree

```
                    ┌──────────────────┐
                    │ Operator profile?│
                    └────────┬─────────┘
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   ┌─────────┐          ┌─────────┐          ┌──────────┐
   │ Derived │          │   MPC   │          │Custodial │
   │SLIP-0010│          │  k-of-n │          │ HSM/KMS  │
   └────┬────┘          └────┬────┘          └────┬─────┘
  Solo / SMB           High-value /          Enterprise +
  default              multi-stakeholder     compliance
        │                    │                    │
  master seed =        operator + OCCA +    OCCA-managed signer
  controlling_         3rd-party shares     + per-action policy
  authority            quorum Ed25519 TSS   (limits, allowlist,
        │                    │                windows)
  m/44'/501'/idx'/0h          │                   │
        │              no single party            │
  delegated signer     can sign alone             │
  + transparency log         │                    │
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
              agent_address signs on-chain
```

### Derived (Default)

```
Operator Master Seed
  └─ SLIP-0010 hardened derive
       └─ Agent Keypair (private key held by OCCA delegated signer)
            └─ Signs: commit_trace for tasks the Command Center dispatches
```

**Important trust model (Whitepaper §8.3):**
What technically signs is the **OCCA delegated trace-anchor signer** holding the derived private key. The agent itself is not an independent signer in this model.

Mitigations:

- Narrow capability: only `commit_trace` for the specific agent
- Dispatch-source validation: only tasks dispatched by Command Center
- Structural output validation before signing
- **Transparency log** — append-only, hash-chained, public; every signature must appear in the log
- Operator can revoke delegation via a Privileged-class transaction

### Threshold MPC (Opt-in, Phase 1)

```
Key Shares: [Operator] + [OCCA] + [Optional 3rd Party]
  └─ k-of-n quorum → joint signing
       └─ No single party can produce a signature alone
```

**Vendor landscape (as of May 2026):**

- **Privy** — Solana support via embedded wallets & server wallets, signing built-in. Not a pure multi-party Ed25519 TSS
- **Turnkey** — HSM-based wallet infrastructure, Solana support, policy engine
- **Web3Auth** — MPC threshold network, Ed25519 support
- **Threshold-friendly libraries** — `tss-lib` (Go), academic Ed25519 TSS implementations

> **Disclaimer:** Vendor capabilities evolve quickly. Verify native multi-party Ed25519 TSS support against the latest vendor docs before any production decision.

### Custodial (Enterprise Tier)

```
OCCA-managed signer
  └─ Per-action policy: limits, allowlists, time windows
```

Dedicated infrastructure tier (Whitepaper §11.3) for operators with compliance requirements that prohibit operator-side custody.

---

## On-Chain Hierarchy

### Layered View

```
┌─────────────────────────────────────────────────────────────────┐
│  OPERATOR LAYER                                                 │
│    Operator Wallet  (EOA / Multi-sig / Governance contract)     │
└────────────────────────────┬────────────────────────────────────┘
                             │ signs Privileged-class tx
                             │ (transfer_authority, set_policy, …)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  IDENTITY LAYER  (PDAs — permanent, address never changes)      │
│                                                                 │
│    ┌────────────────────────────────────────┐                   │
│    │ CompanyAccount PDA                     │                   │
│    │   seeds: ["company", auth, nonce]      │──┐                │
│    │   fields: controlling_authority,       │  │                │
│    │           treasury, policy, …          │  │ owns           │
│    └─────────────┬──────────────────────────┘  │                │
│                  │                             │                │
│       ┌──────────┴──────────┐                  │                │
│       ▼                     ▼                  │                │
│  ┌──────────────┐      ┌──────────────┐        │                │
│  │ AgentAccount │      │ AgentAccount │        │                │
│  │ PDA #0       │      │ PDA #1       │        │                │
│  │ seeds:       │      │ seeds:       │        │                │
│  │  agent+CO+0  │      │  agent+CO+1  │        │                │
│  └──────┬───────┘      └──────┬───────┘        │                │
└─────────┼─────────────────────┼────────────────┼────────────────┘
          │ agent_address       │ agent_address  │
          ▼                     ▼                │
┌─────────────────────────────────────────┐      │
│  WALLET LAYER  (rotatable signers)      │      │
│   ┌───────────────┐   ┌───────────────┐ │      │
│   │ Key A         │   │ Key B         │ │      │
│   │ SLIP-0010     │   │ MPC threshold │ │      │
│   └───────┬───────┘   └───────┬───────┘ │      │
└───────────┼───────────────────┼─────────┘      │
            │ commit_trace      │ commit_trace   │
            ▼                   ▼                │
┌─────────────────────────────────────────┐      │
│  TRACE ANCHOR LAYER                     │      │
│   ┌──────────────┐   ┌──────────────┐   │      │
│   │ TraceAnchor  │   │ TraceAnchor  │   │      │
│   │ task_id_1    │   │ task_id_2    │   │      │
│   └──────────────┘   └──────────────┘   │      │
└─────────────────────────────────────────┘      │
                                                 │ pointers
┌────────────────────────────────────────────────┴────────────────┐
│  TREASURY LAYER  (sibling PDAs, also owned by CompanyAccount)   │
│    TreasuryAccount PDA   seeds: ["treasury", company_pda]       │
│    PolicyAccount  PDA    seeds: ["policy",   company_pda]       │
└─────────────────────────────────────────────────────────────────┘

  Phase 2+ (optional):
    Token-2022 SBT (NonTransferable) ──minted to──▶ AgentAccount PDA
```

### Lifecycle: Create → Rotate → Transfer

```
Phase 1 — Company Creation
  Operator ──create_company(nonce)──▶ Registry Program
                                         ├─ init CompanyAccount PDA
                                         ├─ init TreasuryAccount PDA
                                         └─ init default PolicyAccount

Phase 2 — Agent Registration
  Operator: derive keypair via SLIP-0010 path m/44'/501'/0'/0'
  Operator ──register_agent(custody=Derived, index=0)──▶ Registry
                                         └─ init AgentAccount PDA
                                              seeds: agent + company + 0

Phase 3 — Key Rotation (compromise / scheduled)
  Operator: derive new keypair at index=1
  Operator ──update_agent(new_addr, index=1)──▶ Registry
                                         └─ mutate AgentAccount fields
                                            (PDA address UNCHANGED
                                             ⇒ reputation preserved)

Phase 4 — Authority Transfer (sale / handover)
  Current authority ──transfer_authority(new_auth)──▶ Registry
                                         └─ mutate controlling_authority
                                            (PDA address UNCHANGED
                                             ⇒ company identity intact)
```

---

## Soul-Bound Badge Layer (Optional, Phase 2+)

The Token-2022 `NonTransferable` extension enables soul-bound tokens (SBTs) — tokens that cannot be transferred after minting.

**Use cases in OCCA:**

- Achievement badges ("100 tasks completed", "verified in domain X")
- Skill credentials from third-party verifiers
- Compliance attestations

**Pattern:** mint the SBT to the `AgentAccount` PDA (not to `agent_address`) so the badge follows the canonical identity across key rotations.

**Note:** PDAs cannot sign — burning/closing a badge requires a program holding mint authority. Standard pattern: the same program that mints also manages lifecycle.

---

## Instruction Surface (identity-relevant subset)

| Instruction          | Program      | Signer                                            | Action                                                                     |
| -------------------- | ------------ | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `create_company`     | Registry     | Operator EOA                                      | Instantiate `CompanyAccount` + `TreasuryAccount` + default `PolicyAccount` |
| `transfer_authority` | Registry     | Current authority                                 | Update `controlling_authority`                                             |
| `register_agent`     | Registry     | Controlling authority                             | Create `AgentAccount` PDA, set `derivation_index = 0`                      |
| `update_agent`       | Registry     | Controlling authority                             | Rotate `agent_address`, increment `derivation_index`, status updates       |
| `retire_agent`       | Registry     | Controlling authority                             | Set `status = Retired`                                                     |
| `set_policy`         | Treasury     | Controlling authority (Privileged)                | Update `PolicyAccount`                                                     |
| `commit_trace`       | Trace Anchor | Agent address (= `agent_address` in AgentAccount) | Anchor trace hash                                                          |

The full instruction surface is in Whitepaper §9.3.

---

## Cost Estimates (Rent-exempt, indicative)

Rough estimates based on a rent rate of ~6960 lamports/byte. Includes Anchor's 8-byte discriminator.

| Account                            | Approx size                  | Approx cost              |
| ---------------------------------- | ---------------------------- | ------------------------ |
| `CompanyAccount` (no metadata_uri) | ~120 bytes                   | ~0.0008 SOL              |
| `CompanyAccount` (typical)         | ~200–300 bytes               | ~0.0015–0.0021 SOL       |
| `AgentAccount`                     | ~120 bytes                   | ~0.0008 SOL              |
| `TreasuryAccount`                  | varies                       | varies                   |
| `PolicyAccount`                    | varies with `allowed_assets` | ~0.001–0.003 SOL         |
| `TraceAnchorAccount`               | ~144 bytes                   | ~0.001 SOL **per trace** |

> Numbers are indicative — verify with `Rent::get().minimum_balance(size)` at runtime before production.

**vs NFT Registry per agent (Autonolas-style):** ~0.012 SOL (mint + token account + metadata). The PDA approach is ~10x cheaper.

**Trace anchor cost consideration:** since each task produces one `TraceAnchorAccount` PDA, consider **compressed accounts** or Merkle-tree batching in Phase 2 for high-volume operators.

---

## Migration from the Current Off-Chain System

**Current state (PostgreSQL):** Company and agent identities live in SQL tables. Solana wallets are used only for sign-in nonces.

**Target state:** PDAs on-chain as the canonical source of truth, PostgreSQL as cache/index.

### Phase 1 — Foundation

1. Deploy the Registry Program (Anchor) with `create_company`, `register_agent`, `update_agent`
2. Deploy the Treasury Program with a default `PolicyAccount`
3. For each existing company → submit `create_company`, store the PDA address in DB
4. For each existing agent → submit `register_agent` with `derivation_index = 0`, derive the keypair, store `agent_address` in `AgentAccount`

### Phase 2 — Trace Anchoring

1. Deploy the Trace Anchor Program with `commit_trace`
2. Worker: after a task completes → derive the agent keypair via SLIP-0010 → sign `commit_trace`
3. Implement the transparency log (off-chain, append-only) per Whitepaper §8.3
4. DB stores `task_id` ↔ `TraceAnchorAccount` PDA mapping for fast lookup

### Phase 3 — Custody Options & Rotation

1. Implement the `update_agent` rotation flow + operator UI
2. Settle-pending-payments check before rotation
3. Opt-in MPC custody for enterprise agents (vendor TBD per disclaimer above)
4. Custodial-tier provisioning for the dedicated infra tier

### Phase 4 — Marketplace, Reputation, Badge Layer

1. Deploy the Marketplace Program (Labor Market + Template Marketplace)
2. Deploy the Reputation Program (read views)
3. (Optional) Soul-bound badge program with Token-2022 `NonTransferable`

---

## Security Considerations

| Risk                                          | Mitigation                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Master seed compromise                        | All derived agent keys compromised → use MPC custody for high-value agents        |
| Delegated signer compromise (derived custody) | Transparency log audit — operators monitor for log/dispatch inconsistencies       |
| PDA data tampering                            | Impossible without a signed instruction — program-enforced                        |
| Rotation without settlement                   | Operator must settle first — in-flight payments to old address don't auto-forward |
| Single program upgrade authority              | Addressed in Whitepaper §9.6 (upgrade authority governance)                       |
| MPC vendor lock-in                            | Choose providers with exportable shares or standardized TSS schemes               |

---

## Cross-References

- **Whitepaper §8.2** — Identity & Key Custody (3 custody models, derivation, rotation)
- **Whitepaper §8.3** — Trace Integrity (signing path per custody model, transparency log)
- **Whitepaper §8.4** — Treasury Authorization (Routine/Discretionary/Privileged)
- **Whitepaper §9.1–9.3** — Program Architecture, Account Model, Instruction Surface
- **Whitepaper §9.6** — Upgrade Authority
- **Whitepaper §11.3** — Dedicated Infrastructure Tier (custodial)
- **Whitepaper Appendix A** — Account Schema Summary (source of truth for field types)

---

## External References

- [SLIP-0010](https://github.com/satoshilabs/slips/blob/master/slip-0010.md) — Ed25519 HD Key Derivation
- [Solana PDA Documentation](https://solana.com/docs/core/pda)
- [Token-2022 NonTransferable Extension](https://www.solana-program.com/docs/token-2022/extensions) — soulbound token mechanism
- [Anchor Account Types](https://www.anchor-lang.com/docs/references/account-types) — discriminator, Space trait, InitSpace macro
- Autonolas Registries — canonical-vs-instance pattern reference (NFT-based, EVM)
