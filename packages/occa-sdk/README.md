# occa-sdk

OCCA on-chain protocol SDK for Solana. PDA helpers, instruction builders, and the **sign-to-derive** custody model for the OCCA Registry program.

> Status: **devnet**. Program `oCCAYWgH3KTWccrdHUkrGZQK8YAGTNVQp4V4Hxsv8LQ`. APIs may change before 1.0.

## Install

```bash
npm install occa-sdk @solana/web3.js
# or: pnpm add occa-sdk @solana/web3.js
```

## What's inside

- **`buildCreateCompanyInstruction` / `buildRegisterAgentInstruction`** — Borsh-encoded `TransactionInstruction` builders. No Anchor runtime dependency.
- **`deriveCompanyPda` / `deriveAgentPda`** — PDA derivation that mirrors the on-chain seeds byte-for-byte.
- **`buildAgentDerivationMessage` / `deriveAgentKeypairFromSignature`** — sign-to-derive custody. The user's wallet signs a deterministic message; the signature is hashed (blake3) into a 32-byte seed and turned into an Ed25519 keypair. The SDK never holds the agent privkey.
- **`REGISTRY_PROGRAM_ID`, `CUSTODY_MODEL_ON_CHAIN`** — constants pinned to the deployed program.

## Quick start

```ts
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildCreateCompanyInstruction,
  buildRegisterAgentInstruction,
  buildAgentDerivationMessage,
  deriveAgentKeypairFromSignature,
  CURRENT_DERIVATION_MSG_VERSION,
  CUSTODY_MODEL_ON_CHAIN,
  REGISTRY_PROGRAM_ID,
} from "occa-sdk";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const operator = Keypair.generate(); // funded payer + controlling_authority

// 1. create_company
const nonce = Math.floor(Date.now() / 1000) & 0xffffffff;
const { instruction: createIx, companyPda } = buildCreateCompanyInstruction({
  authority: operator.publicKey,
  payer: operator.publicKey,
  nonce,
  metadataUri: "ipfs://...",
});
// sign + send `createIx` with operator as feePayer

// 2. derive an agent address from the user's wallet signature
const message = buildAgentDerivationMessage({
  companyPda: companyPda.toBase58(),
  agentIndex: 0,
  version: CURRENT_DERIVATION_MSG_VERSION,
});
const walletSignature = await wallet.signMessage(
  new TextEncoder().encode(message),
);
const agentKeypair = deriveAgentKeypairFromSignature(walletSignature);

// 3. register_agent
const { instruction: registerIx } = buildRegisterAgentInstruction({
  companyPda,
  controllingAuthority: operator.publicKey,
  payer: operator.publicKey,
  agentIndex: 0,
  agentAddress: agentKeypair.publicKey,
  custodyModel: CUSTODY_MODEL_ON_CHAIN.SignToDerive,
  roleId: 0,
  adapterId: PublicKey.default,
});
// sign + send `registerIx` with operator as feePayer
```

## Sign-to-derive in one line

```
agentKeypair = ed25519(blake3(walletSignature(canonicalMessage)))
```

Properties:

- **Deterministic** — same wallet + same `(companyPda, agentIndex)` → same agent keypair every time.
- **Recoverable** — as long as the user holds the wallet, the agent keypair can be re-derived. OCCA stores nothing.
- **Phantom-compatible** — uses `wallet.signMessage`, no exotic derivation paths required.

## Subpath imports

```ts
import { deriveCompanyPda } from "occa-sdk/pda";
import { REGISTRY_PROGRAM_ID } from "occa-sdk/constants";
import { buildAgentDerivationMessage } from "occa-sdk/derivation";
import { buildCreateCompanyInstruction } from "occa-sdk/instructions";
```

## Devnet program

```
oCCAYWgH3KTWccrdHUkrGZQK8YAGTNVQp4V4Hxsv8LQ
```

## License

MIT
