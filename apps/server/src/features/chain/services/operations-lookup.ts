// OperationsAccount reads — decode the on-chain capability binding for a
// given (company, kind) pair. Mirrors `treasury-lookup.ts`.

import { PublicKey } from "@solana/web3.js";
import {
  OPERATIONS_KIND,
  TREASURY_ACCOUNT_DISCRIMINATOR,
  TREASURY_PROGRAM_ID,
  deriveOperationsPda,
  type OperationsKind,
} from "occa-sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:operations-lookup");

class Cursor {
  constructor(
    private readonly data: Buffer,
    private offset: number,
  ) {}
  readU8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
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
  readPubkey(): PublicKey {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  readBool(): boolean {
    return this.readU8() === 1;
  }
  readActionWhitelist(): string[] {
    const len = this.readU32();
    const out: string[] = [];
    for (let i = 0; i < len; i += 1) {
      const bytes = this.data.subarray(this.offset, this.offset + 8);
      out.push(bytes.toString("hex"));
      this.offset += 8;
    }
    return out;
  }
}

export interface OperationsState {
  kind: OperationsKind;
  pda: string;
  exists: boolean;
  /** Hot wallet authorized to sign whitelisted ix. */
  signer: string | null;
  /** Hex-encoded 8-byte Anchor instruction discriminators (no 0x prefix). */
  actionWhitelist: string[];
  rateLimitPerPeriod: number;
  signaturesThisPeriod: number;
  /** Unix seconds aligned to start of current calendar month UTC. `0` = uninit. */
  currentPeriodAnchor: string;
  /** Unix seconds. `0` = no expiry. */
  expiryUnix: string;
  revoked: boolean;
}

function emptyState(
  kind: OperationsKind,
  pda: PublicKey,
): OperationsState {
  return {
    kind,
    pda: pda.toBase58(),
    exists: false,
    signer: null,
    actionWhitelist: [],
    rateLimitPerPeriod: 0,
    signaturesThisPeriod: 0,
    currentPeriodAnchor: "0",
    expiryUnix: "0",
    revoked: false,
  };
}

/**
 * Read both Disbursement + Anchor OperationsAccount for one company. Returns
 * stub objects with `exists: false` for kinds that haven't been registered
 * yet — UI can render the "Set up" CTA off that signal.
 */
export async function fetchAllOperationsState(
  companyPda: PublicKey,
): Promise<OperationsState[]> {
  const conn = getConnection();
  const disbursementPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Disbursement,
  ).pda;
  const anchorPda = deriveOperationsPda(
    companyPda,
    OPERATIONS_KIND.Anchor,
  ).pda;

  const [disbursementInfo, anchorInfo] = await conn.getMultipleAccountsInfo(
    [disbursementPda, anchorPda],
    "confirmed",
  );

  const decode = (
    info: typeof disbursementInfo,
    kind: OperationsKind,
    pda: PublicKey,
  ): OperationsState => {
    if (!info || !info.owner.equals(TREASURY_PROGRAM_ID)) {
      return emptyState(kind, pda);
    }
    if (
      !info.data
        .subarray(0, 8)
        .equals(TREASURY_ACCOUNT_DISCRIMINATOR.OperationsAccount)
    ) {
      log.warn(
        { pda: pda.toBase58() },
        "OperationsAccount discriminator mismatch",
      );
      return emptyState(kind, pda);
    }
    try {
      // Layout (post 8-byte discriminator):
      //   version u8, company pubkey, kind u8, signer pubkey,
      //   action_whitelist Vec<[u8;8]>,
      //   rate_limit_per_period u32, signatures_this_period u32,
      //   current_period_anchor i64,
      //   expiry_unix i64, revoked bool, bump u8
      const c = new Cursor(info.data, 8);
      c.readU8(); // version
      c.readPubkey(); // company
      c.readU8(); // kind (redundant — we already know from the PDA seed)
      const signer = c.readPubkey();
      const actionWhitelist = c.readActionWhitelist();
      const rateLimitPerPeriod = c.readU32();
      const signaturesThisPeriod = c.readU32();
      const currentPeriodAnchor = c.readI64();
      const expiryUnix = c.readI64();
      const revoked = c.readBool();
      return {
        kind,
        pda: pda.toBase58(),
        exists: true,
        signer: signer.toBase58(),
        actionWhitelist,
        rateLimitPerPeriod,
        signaturesThisPeriod,
        currentPeriodAnchor: currentPeriodAnchor.toString(),
        expiryUnix: expiryUnix.toString(),
        revoked,
      };
    } catch (err) {
      log.error({ err, pda: pda.toBase58() }, "OperationsAccount decode failed");
      return emptyState(kind, pda);
    }
  };

  return [
    decode(disbursementInfo, OPERATIONS_KIND.Disbursement, disbursementPda),
    decode(anchorInfo, OPERATIONS_KIND.Anchor, anchorPda),
  ];
}
