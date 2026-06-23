import { type Connection, PublicKey } from "@solana/web3.js";
import { SOL_PSEUDO_MINT, TREASURY_ACCOUNT_DISCRIMINATOR } from "./constants";
import { deriveProtocolFeePda } from "./pda";
import type { AssetBudget } from "./instructions";

// Account readers — fetch + decode on-chain account data. Instruction
// builders live in `instructions.ts`; this module is the read side.
//
// Layouts mirror `occa-programs/programs/treasury/src/lib.rs`. Anchor frames
// every account with an 8-byte discriminator, then the borsh-encoded struct.

/** Decoded `ProtocolFeeAccount` — the singleton fee accumulator. */
export interface ProtocolFeeAccountData {
  /** The singleton PDA address (seeds = ["protocol_fees"]). */
  address: PublicKey;
  /** Schema version byte. */
  version: number;
  /** Withdrawal authority — only this key can `withdraw_protocol_fees` or
   *  `set_governance`. */
  governance: PublicKey;
  /** Per-asset accumulated fee balances (the accounting truth the program
   *  decrements on withdrawal). */
  balances: AssetBudget[];
  /** PDA bump. */
  bump: number;
  /** Total lamports held by the PDA = rent-exempt minimum + collected SOL. */
  lamports: number;
  /** Convenience: the tracked SOL fee balance in lamports (the `balances`
   *  entry for `SOL_PSEUDO_MINT`, or 0n if none). This is the withdrawable
   *  SOL, distinct from `lamports` which also includes the rent floor. */
  collectedSolLamports: bigint;
}

// ProtocolFeeAccount layout: [8B disc][1B version][32B governance]
// [4B balances len][N x (32B mint + 8B amount u64)][1B bump].
const PFA_DISC_LEN = 8;
const PFA_VERSION_OFFSET = 8;
const PFA_GOVERNANCE_OFFSET = 9;
const PFA_BALANCES_LEN_OFFSET = 41;
const PFA_BALANCES_START = 45;
const ASSET_BUDGET_SIZE = 40; // 32 (mint) + 8 (u64 amount)

/**
 * Decode raw `ProtocolFeeAccount` data. Validates the Anchor discriminator,
 * so passing any other account type throws rather than silently misreading.
 */
export function decodeProtocolFeeAccount(
  address: PublicKey,
  data: Buffer,
  lamports: number,
): ProtocolFeeAccountData {
  if (data.length < PFA_BALANCES_START + 1) {
    throw new Error(
      `ProtocolFeeAccount data too short: ${data.length} bytes`,
    );
  }
  const disc = data.subarray(0, PFA_DISC_LEN);
  if (!disc.equals(TREASURY_ACCOUNT_DISCRIMINATOR.ProtocolFeeAccount)) {
    throw new Error(
      "account discriminator does not match ProtocolFeeAccount",
    );
  }

  const version = data[PFA_VERSION_OFFSET];
  const governance = new PublicKey(
    data.subarray(PFA_GOVERNANCE_OFFSET, PFA_GOVERNANCE_OFFSET + 32),
  );

  const balancesLen = data.readUInt32LE(PFA_BALANCES_LEN_OFFSET);
  const balances: AssetBudget[] = [];
  for (let i = 0; i < balancesLen; i++) {
    const off = PFA_BALANCES_START + i * ASSET_BUDGET_SIZE;
    const mint = new PublicKey(data.subarray(off, off + 32));
    const amount = data.readBigUInt64LE(off + 32);
    balances.push({ mint, amount });
  }

  const bump = data[PFA_BALANCES_START + balancesLen * ASSET_BUDGET_SIZE];
  const sol = balances.find((b) => b.mint.equals(SOL_PSEUDO_MINT));

  return {
    address,
    version,
    governance,
    balances,
    bump,
    lamports,
    collectedSolLamports: sol?.amount ?? 0n,
  };
}

/**
 * Fetch + decode the singleton `ProtocolFeeAccount`. Returns `null` if it
 * has not been initialized yet (no `init_protocol_fee_account` call). The
 * caller supplies the `Connection`; the SDK never opens RPC itself.
 */
export async function fetchProtocolFeeAccount(
  connection: Connection,
  programId?: PublicKey,
): Promise<ProtocolFeeAccountData | null> {
  const { pda } = deriveProtocolFeePda(programId);
  const info = await connection.getAccountInfo(pda);
  if (info === null) {
    return null;
  }
  return decodeProtocolFeeAccount(pda, info.data, info.lamports);
}
