import { Keypair, PublicKey } from "@solana/web3.js";
import { blake3 } from "@noble/hashes/blake3";
import { CURRENT_DERIVATION_MSG_VERSION } from "./constants";

/**
 * Sign-to-derive — OCCA's Phase 1 custody model.
 *
 * The user wallet (Phantom/Solflare/etc) signs a deterministic message;
 * we hash that signature into a 32-byte seed and derive an Ed25519
 * keypair. OCCA never sees the master seed and never stores the agent
 * privkey — only the resulting `agent_address` (pubkey).
 *
 * Properties:
 *  - Deterministic: same wallet + same (companyPda, agentIndex) =>
 *    same agent keypair every time. Re-derivable on demand.
 *  - Recoverable: as long as the user holds the original wallet, the
 *    keypair can be reconstructed; OCCA holds nothing.
 *  - Privkey lives ephemerally in browser memory only when needed
 *    (e.g. signing a future commit_trace transaction).
 *
 * Trade-off vs SLIP-0010 m/44'/501'/idx'/0':
 *  - SLIP-0010 requires the wallet to expose hardened derivation, which
 *    Phantom et al do NOT. signMessage works in every Solana wallet.
 *  - The cost is one extra signature per derivation (negligible UX).
 *
 * NOT for trace integrity yet — we'll layer that in when Trace Anchor
 * lands. For now this is purely identity (register_agent input).
 */

export interface AgentDerivationInputs {
  /** CompanyAccount PDA (base58). */
  companyPda: string;
  /** Per-company u32 agent index. */
  agentIndex: number;
  /** Message format version — pinned at derivation time, persisted in DB. */
  version?: number;
}

/**
 * Build the canonical derivation message. **Must match the server-side
 * verifier byte-for-byte** — any drift here breaks signature verification
 * during register_agent.
 */
export function buildAgentDerivationMessage(
  inputs: AgentDerivationInputs,
): string {
  const v = inputs.version ?? CURRENT_DERIVATION_MSG_VERSION;
  return [
    `OCCA agent derivation v${v}`,
    `company: ${inputs.companyPda}`,
    `agent_index: ${inputs.agentIndex}`,
  ].join("\n");
}

/**
 * Encode the derivation message as UTF-8 bytes (what wallet.signMessage
 * receives). Exposed so callers can pass the exact same bytes to the
 * wallet adapter without re-encoding inconsistencies.
 */
export function encodeDerivationMessage(
  inputs: AgentDerivationInputs,
): Uint8Array {
  return new TextEncoder().encode(buildAgentDerivationMessage(inputs));
}

/**
 * Derive the agent keypair from a signature over the canonical derivation
 * message. The signature itself is treated as entropy; we hash it down to
 * 32 bytes via blake3 and feed Keypair.fromSeed.
 *
 * The signature MUST be a valid 64-byte Ed25519 signature produced by the
 * user wallet over `encodeDerivationMessage(inputs)`. Validate that
 * before calling — passing arbitrary bytes works mechanically but defeats
 * the recovery property.
 */
export function deriveAgentKeypairFromSignature(
  signature: Uint8Array,
): Keypair {
  if (signature.length !== 64) {
    throw new RangeError(
      `expected 64-byte ed25519 signature, got ${signature.length}`,
    );
  }
  const seed = blake3(signature, { dkLen: 32 });
  return Keypair.fromSeed(seed);
}

/**
 * Convenience: full FE-side derivation in one call. Returns the Keypair
 * and the canonical message used (so the caller can ship the message +
 * signature to the server for verification).
 */
export function deriveAgentKeypair(
  inputs: AgentDerivationInputs,
  walletSignature: Uint8Array,
): { keypair: Keypair; pubkey: PublicKey; message: string } {
  const message = buildAgentDerivationMessage(inputs);
  const keypair = deriveAgentKeypairFromSignature(walletSignature);
  return { keypair, pubkey: keypair.publicKey, message };
}

// ── Batch derivation (Phase 2: hybrid kickoff anchor) ───────────────────────
//
// The kickoff flow hires N agents at once. Without batching, that's N
// wallet popups + N on-chain transactions (one per agent). Batch lets us
// take ONE wallet signature and derive N independent keypairs from it,
// each registered in a single (or chunked) on-chain transaction.
//
// Domain separation vs single-agent:
//   single: seed = blake3(sig)
//   batch:  seed = blake3(sig || "batch-v1" || u32_le(agent_index))
//
// The "batch-v1" tag prevents an attacker from re-using a single-agent
// signature as input to batch derivation (or vice versa). Different
// indexes under the same signature produce independent keypairs that
// nobody (including the user) can predict from each other without the
// original signature.

const BATCH_DOMAIN_TAG = new TextEncoder().encode("batch-v1");

export interface BatchDerivationInputs {
  /** CompanyAccount PDA (base58). */
  companyPda: string;
  /** Per-company u32 agent indexes the user is committing to in this
   *  batch. MUST be sorted ascending so server + client agree on order
   *  byte-for-byte; the canonical message embeds the sorted form. */
  agentIndexes: number[];
  /** Message format version. Defaults to CURRENT_DERIVATION_MSG_VERSION. */
  version?: number;
}

/**
 * Build the canonical batch derivation message. Embeds every
 * `agent_index` so a signature over this message commits the user to the
 * exact set being registered — server can't sneak an extra index in.
 */
export function buildBatchDerivationMessage(
  inputs: BatchDerivationInputs,
): string {
  const v = inputs.version ?? CURRENT_DERIVATION_MSG_VERSION;
  const sorted = [...inputs.agentIndexes].sort((a, b) => a - b);
  return [
    `OCCA agent batch derivation v${v}`,
    `company: ${inputs.companyPda}`,
    `agent_indexes: [${sorted.join(",")}]`,
  ].join("\n");
}

export function encodeBatchDerivationMessage(
  inputs: BatchDerivationInputs,
): Uint8Array {
  return new TextEncoder().encode(buildBatchDerivationMessage(inputs));
}

/**
 * Derive a single agent keypair for a given index from a batch signature.
 * Each (signature, agent_index) pair yields an independent Ed25519
 * keypair — no information about one leaks the others.
 */
export function deriveAgentKeypairForIndex(
  signature: Uint8Array,
  agentIndex: number,
): Keypair {
  if (signature.length !== 64) {
    throw new RangeError(
      `expected 64-byte ed25519 signature, got ${signature.length}`,
    );
  }
  if (
    !Number.isInteger(agentIndex) ||
    agentIndex < 0 ||
    agentIndex > 0xff_ff_ff_ff
  ) {
    throw new RangeError(`agentIndex out of u32 range: ${agentIndex}`);
  }
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, agentIndex, true);

  // blake3 accepts a single Uint8Array; concat once instead of streaming
  // (input is < 100 bytes total, perf is irrelevant).
  const input = new Uint8Array(
    signature.length + BATCH_DOMAIN_TAG.length + indexBytes.length,
  );
  input.set(signature, 0);
  input.set(BATCH_DOMAIN_TAG, signature.length);
  input.set(indexBytes, signature.length + BATCH_DOMAIN_TAG.length);

  const seed = blake3(input, { dkLen: 32 });
  return Keypair.fromSeed(seed);
}

/**
 * Convenience: derive every keypair in a batch in one call. Returns a
 * map keyed by agent_index so callers can pair derivations with their
 * source rows without relying on array order.
 */
export function deriveAgentKeypairsForBatch(
  signature: Uint8Array,
  agentIndexes: number[],
): Map<number, Keypair> {
  const out = new Map<number, Keypair>();
  for (const idx of agentIndexes) {
    out.set(idx, deriveAgentKeypairForIndex(signature, idx));
  }
  return out;
}
