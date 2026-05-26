// Treasury program account reads — TreasuryAccount + PolicyAccount.
//
// Mirrors `chain-lookup.ts` (registry decoding) for the treasury program.
// Chain is the source of truth for value-layer state; these decoders let
// the Treasury UI render budgets, balance, and fee config straight from
// chain rather than a DB cache.

import { PublicKey } from "@solana/web3.js";
import {
  TREASURY_ACCOUNT_DISCRIMINATOR,
  TREASURY_PROGRAM_ID,
  SOL_PSEUDO_MINT,
  deriveTreasuryPda,
  derivePolicyPda,
} from "occa-sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:treasury-lookup");

// Borsh cursor — treasury accounts have variable-length vecs so fixed
// offsets don't work past the first one; sequence-read instead.
class Cursor {
  constructor(
    private readonly data: Buffer,
    private offset: number,
  ) {}
  skip(n: number): void {
    this.offset += n;
  }
  readU8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readU16(): number {
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  readU32(): number {
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  readI64(): bigint {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  readU64(): bigint {
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  readPubkey(): PublicKey {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  readVec<T>(readItem: () => T): T[] {
    const len = this.readU32();
    const out: T[] = [];
    for (let i = 0; i < len; i += 1) out.push(readItem());
    return out;
  }
  readOptionPubkey(): PublicKey | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    return this.readPubkey();
  }
}

export interface AssetBudget {
  mint: string;
  amount: bigint;
}

function readAssetBudget(c: Cursor): AssetBudget {
  return { mint: c.readPubkey().toBase58(), amount: c.readU64() };
}

// SOL entry from a Vec<AssetBudget> — the marker mint is the all-zero
// pseudo-mint. Returns 0n when the asset isn't present.
function solAmount(budgets: AssetBudget[]): bigint {
  const sol = SOL_PSEUDO_MINT.toBase58();
  return budgets.find((b) => b.mint === sol)?.amount ?? 0n;
}

export interface TreasuryState {
  treasuryPda: string;
  policyPda: string;
  /** Lamports custodied on the TreasuryAccount PDA (SOL balance). */
  balanceLamports: number;
  /** True once `init_treasury` has run (TreasuryAccount exists on chain). */
  initialized: boolean;
  /** SOL routine budget for the current calendar month, lamports. Used by
   *  `disburse_routine` (auto-payouts). */
  routineBudgetLamports: bigint;
  /** SOL routine spend so far this period, lamports. */
  routineSpentLamports: bigint;
  /** SOL discretionary budget for the current calendar month, lamports.
   *  Used by `disburse_discretionary` (operator-signed ad-hoc). */
  discretionaryBudgetLamports: bigint;
  /** SOL discretionary spend so far this period, lamports. */
  discretionarySpentLamports: bigint;
  /** Agent Operating Fee in basis points (300 = 3%). */
  agentOperatingFeeBps: number;
}

/**
 * Fetch + decode a company's TreasuryAccount + PolicyAccount. Returns
 * `initialized: false` (with zeroed fields) when the treasury PDA has no
 * account yet — e.g. a company anchored before the CPI-init flow.
 */
export async function fetchTreasuryState(
  companyPda: PublicKey,
): Promise<TreasuryState> {
  const conn = getConnection();
  const treasuryPda = deriveTreasuryPda(companyPda).pda;
  const policyPda = derivePolicyPda(companyPda).pda;

  const [treasuryInfo, policyInfo] = await conn.getMultipleAccountsInfo(
    [treasuryPda, policyPda],
    "confirmed",
  );

  const base = {
    treasuryPda: treasuryPda.toBase58(),
    policyPda: policyPda.toBase58(),
    balanceLamports: treasuryInfo?.lamports ?? 0,
  };

  if (
    !treasuryInfo ||
    !treasuryInfo.owner.equals(TREASURY_PROGRAM_ID) ||
    !policyInfo ||
    !policyInfo.owner.equals(TREASURY_PROGRAM_ID)
  ) {
    return {
      ...base,
      initialized: false,
      routineBudgetLamports: 0n,
      routineSpentLamports: 0n,
      discretionaryBudgetLamports: 0n,
      discretionarySpentLamports: 0n,
      agentOperatingFeeBps: 0,
    };
  }

  // Discriminator sanity check before decoding.
  if (
    !policyInfo.data
      .subarray(0, 8)
      .equals(TREASURY_ACCOUNT_DISCRIMINATOR.PolicyAccount)
  ) {
    log.warn(
      { policyPda: policyPda.toBase58() },
      "fetchTreasuryState: policy discriminator mismatch",
    );
    return {
      ...base,
      initialized: false,
      routineBudgetLamports: 0n,
      routineSpentLamports: 0n,
      discretionaryBudgetLamports: 0n,
      discretionarySpentLamports: 0n,
      agentOperatingFeeBps: 0,
    };
  }

  try {
    // PolicyAccount layout (post 8-byte discriminator):
    //   version u8, company pubkey,
    //   routine_budget Vec<AssetBudget>, discretionary_budget Vec<AssetBudget>,
    //   privileged_threshold_lamports u64,
    //   privileged_threshold_per_token Vec<AssetBudget>,
    //   secondary_signer Option<pubkey>, agent_operating_fee_bps u16,
    //   current_period_anchor i64,
    //   routine_spent Vec<AssetBudget>, discretionary_spent Vec<AssetBudget>,
    //   bump u8
    const c = new Cursor(policyInfo.data, 8);
    c.skip(1); // version
    c.skip(32); // company
    const routineBudget = c.readVec(() => readAssetBudget(c));
    const discretionaryBudget = c.readVec(() => readAssetBudget(c));
    c.skip(8); // privileged_threshold_lamports
    c.readVec(() => readAssetBudget(c)); // privileged_threshold_per_token
    c.readOptionPubkey(); // secondary_signer
    const feeBps = c.readU16();
    c.skip(8); // current_period_anchor
    const routineSpent = c.readVec(() => readAssetBudget(c));
    const discretionarySpent = c.readVec(() => readAssetBudget(c));

    return {
      ...base,
      initialized: true,
      routineBudgetLamports: solAmount(routineBudget),
      routineSpentLamports: solAmount(routineSpent),
      discretionaryBudgetLamports: solAmount(discretionaryBudget),
      discretionarySpentLamports: solAmount(discretionarySpent),
      agentOperatingFeeBps: feeBps,
    };
  } catch (err) {
    log.error(
      { err, policyPda: policyPda.toBase58() },
      "fetchTreasuryState: policy decode failed",
    );
    return {
      ...base,
      initialized: false,
      routineBudgetLamports: 0n,
      routineSpentLamports: 0n,
      discretionaryBudgetLamports: 0n,
      discretionarySpentLamports: 0n,
      agentOperatingFeeBps: 0,
    };
  }
}
