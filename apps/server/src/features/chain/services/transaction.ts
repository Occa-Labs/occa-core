import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "../../../infra/solana/connection";

/**
 * Build, sign, send, and confirm a single-instruction transaction with the
 * operator + extra signers. Returns the confirmed signature.
 *
 * Adds a small priority fee so devnet doesn't drop the tx during congestion.
 */
export async function sendAndConfirmInstruction(args: {
  instruction: TransactionInstruction;
  payer: Keypair;
  extraSigners?: Keypair[];
  priorityMicroLamports?: number;
}): Promise<string> {
  const conn = getConnection();
  const tx = new Transaction();
  if (args.priorityMicroLamports !== undefined) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: args.priorityMicroLamports,
      }),
    );
  }
  tx.add(args.instruction);

  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.payer.publicKey;

  const signers = [args.payer, ...(args.extraSigners ?? [])];
  // Dedupe by pubkey (operator may also be a relevant signer elsewhere).
  const seen = new Set<string>();
  const uniqueSigners = signers.filter((s) => {
    const k = s.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  tx.sign(...uniqueSigners);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

/**
 * Returns true if a PDA already exists on-chain (i.e. the corresponding
 * instruction would fail with "account already in use").
 */
export async function accountExists(pda: PublicKey): Promise<boolean> {
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  return info !== null;
}
