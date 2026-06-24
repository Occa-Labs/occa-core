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
  deriveAssociatedTokenAddress,
  deriveTreasuryPda,
  derivePolicyPda,
} from "@occa/sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:treasury-lookup");

const SOL_MINT = SOL_PSEUDO_MINT.toBase58();

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

// Amount for a specific mint from a Vec<AssetBudget>. SOL uses the all-zero
// pseudo-mint marker. Returns 0n when the asset isn't present (no budget set
// for it yet).
function amountForMint(budgets: AssetBudget[], mint: string): bigint {
  return budgets.find((b) => b.mint === mint)?.amount ?? 0n;
}

export interface TreasuryState {
  treasuryPda: string;
  policyPda: string;
  /** The asset all the budget/spent/assetBalance figures below are for —
   *  base58 mint, all-zero pseudo-mint for SOL. */
  mint: string;
  /** Native SOL lamports on the TreasuryAccount PDA. Always the SOL balance
   *  regardless of `mint` — it's the gas + ATA-rent source for every asset. */
  balanceLamports: number;
  /** Custodied balance of `mint` in its base units. For SOL this equals
   *  `balanceLamports`; for an SPL mint it's the treasury ATA token amount. */
  assetBalance: number;
  /** True once `init_treasury` has run (TreasuryAccount exists on chain). */
  initialized: boolean;
  /** Routine budget of `mint` for the current calendar month, base units.
   *  Used by `disburse_routine` (auto-payouts). */
  routineBudgetLamports: bigint;
  /** Routine spend so far this period, base units of `mint`. */
  routineSpentLamports: bigint;
  /** Discretionary budget of `mint` for the current calendar month, base
   *  units. Used by `disburse_discretionary` (operator-signed ad-hoc). */
  discretionaryBudgetLamports: bigint;
  /** Discretionary spend so far this period, base units of `mint`. */
  discretionarySpentLamports: bigint;
  /** Agent Operating Fee in basis points (300 = 3%). Asset-agnostic. */
  agentOperatingFeeBps: number;
}

/**
 * Read the treasury's custodied balance of an SPL mint — the token amount in
 * the treasury PDA's associated token account. Returns 0 when the ATA does
 * not exist yet (nothing funded into that asset). Never throws.
 */
async function fetchTreasuryTokenBalance(
  treasuryPda: PublicKey,
  mint: string,
): Promise<number> {
  try {
    const conn = getConnection();
    const ata = deriveAssociatedTokenAddress(treasuryPda, new PublicKey(mint));
    const bal = await conn.getTokenAccountBalance(ata, "confirmed");
    return Number(bal.value.amount);
  } catch {
    // Missing ATA / unfunded asset — treat as zero balance.
    return 0;
  }
}

/**
 * Read a company's FULL per-asset budget vecs from the PolicyAccount —
 * every mint, not just one. Needed before `set_policy`, which REPLACES the
 * whole vec on-chain: to change one asset's budget without wiping the
 * others, the caller merges the target mint into these and resends all.
 * Returns empty vecs when the policy isn't initialized or can't be decoded.
 */
export async function fetchPolicyBudgetVecs(
  companyPda: PublicKey,
): Promise<{ routine: AssetBudget[]; discretionary: AssetBudget[] }> {
  const conn = getConnection();
  const policyPda = derivePolicyPda(companyPda).pda;
  const policyInfo = await conn.getAccountInfo(policyPda, "confirmed");
  const empty = { routine: [], discretionary: [] };
  if (
    !policyInfo ||
    !policyInfo.owner.equals(TREASURY_PROGRAM_ID) ||
    !policyInfo.data.subarray(0, 8).equals(TREASURY_ACCOUNT_DISCRIMINATOR.PolicyAccount)
  ) {
    return empty;
  }
  try {
    const c = new Cursor(policyInfo.data, 8);
    c.skip(1); // version
    c.skip(32); // company
    const routine = c.readVec(() => readAssetBudget(c));
    const discretionary = c.readVec(() => readAssetBudget(c));
    return { routine, discretionary };
  } catch (err) {
    log.error(
      { err, policyPda: policyPda.toBase58() },
      "fetchPolicyBudgetVecs: decode failed",
    );
    return empty;
  }
}

/**
 * Fetch + decode a company's TreasuryAccount + PolicyAccount for one payout
 * asset. `mint` defaults to SOL (back-compat with all existing callers).
 * Returns `initialized: false` (with zeroed fields) when the treasury PDA has
 * no account yet — e.g. a company anchored before the CPI-init flow.
 */
export async function fetchTreasuryState(
  companyPda: PublicKey,
  mint: string = SOL_MINT,
): Promise<TreasuryState> {
  const conn = getConnection();
  const treasuryPda = deriveTreasuryPda(companyPda).pda;
  const policyPda = derivePolicyPda(companyPda).pda;

  const [treasuryInfo, policyInfo] = await conn.getMultipleAccountsInfo(
    [treasuryPda, policyPda],
    "confirmed",
  );

  const solBalance = treasuryInfo?.lamports ?? 0;
  // Active-asset balance: native lamports for SOL, ATA token amount for SPL.
  const assetBalance =
    mint === SOL_MINT
      ? solBalance
      : await fetchTreasuryTokenBalance(treasuryPda, mint);

  const base = {
    treasuryPda: treasuryPda.toBase58(),
    policyPda: policyPda.toBase58(),
    mint,
    balanceLamports: solBalance,
    assetBalance,
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
      routineBudgetLamports: amountForMint(routineBudget, mint),
      routineSpentLamports: amountForMint(routineSpent, mint),
      discretionaryBudgetLamports: amountForMint(discretionaryBudget, mint),
      discretionarySpentLamports: amountForMint(discretionarySpent, mint),
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
