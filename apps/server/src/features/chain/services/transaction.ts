import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "../../../infra/solana/connection";

/**
 * Prepare a transaction whose owner signature must come from the FE
 * wallet. Operator (server) is the fee-payer and partially signs the
 * tx; the resulting base64 blob is sent to the browser, where the
 * connected wallet adds the owner signature and broadcasts.
 *
 * Why partial-sign on the server: we want the operator to commit to a
 * specific blockhash + ix bundle before handing off, so the FE can't
 * smuggle additional ix into the tx without invalidating signatures.
 *
 * Returns:
 *   - `transactionBase64`  → send to FE for `wallet.signTransaction`
 *   - `lastValidBlockHeight` → FE may use this to abort if expired
 *
 * Caller passes `requiredOwnerSigners` so we DON'T set them on the
 * server side (they sign in the browser). We add them as PublicKeys on
 * the AccountMeta `isSigner: true` slots — those are already encoded
 * in `args.instructions`, so we don't pass them explicitly to
 * `tx.sign(...)`.
 */
export async function prepareOwnerSignedTx(args: {
  instructions: TransactionInstruction[];
  feePayer: Keypair;
  priorityMicroLamports?: number;
}): Promise<{
  transactionBase64: string;
  lastValidBlockHeight: number;
  blockhash: string;
}> {
  if (args.instructions.length === 0) {
    throw new Error("prepareOwnerSignedTx: empty instructions array");
  }
  const conn = getConnection();
  const tx = new Transaction();
  if (args.priorityMicroLamports !== undefined) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: args.priorityMicroLamports,
      }),
    );
  }
  for (const ix of args.instructions) tx.add(ix);

  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.feePayer.publicKey;

  // Partial-sign as fee-payer. The owner signature slot stays empty
  // until the wallet fills it in browser-side.
  tx.partialSign(args.feePayer);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return {
    transactionBase64: serialized.toString("base64"),
    lastValidBlockHeight,
    blockhash,
  };
}

/**
 * Submit a fully-signed transaction (base64) on behalf of the FE: send
 * the raw bytes to the cluster, then confirm.
 *
 * Returns the on-chain signature.
 */
export async function submitSignedTx(args: {
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}): Promise<string> {
  const conn = getConnection();
  const raw = Buffer.from(args.signedTransactionBase64, "base64");
  // skipPreflight: true — Solana's preflight simulation uses the RPC
  // node's view of the cluster, which on devnet often hasn't propagated
  // a freshly-issued blockhash yet (~3-5s lag). That window is exactly
  // when a user-signed tx submits, so preflight rejects with
  // "Blockhash not found" even though the blockhash is valid. Skipping
  // preflight sends the tx straight to the leader; any real ix error
  // surfaces in `confirmTransaction` below.
  const sig = await conn.sendRawTransaction(raw, {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction(
    {
      signature: sig,
      blockhash: args.blockhash,
      lastValidBlockHeight: args.lastValidBlockHeight,
    },
    "confirmed",
  );
  return sig;
}

/**
 * Wait for the FE-broadcast signature to finalize, then return the
 * decoded transaction so callers can verify it ran the expected ix.
 *
 * Throws if the signature isn't found within the polling budget or if
 * the transaction errored on-chain.
 */
export async function awaitConfirmedTx(
  signature: string,
  opts: { timeoutMs?: number } = {},
): Promise<
  NonNullable<
    Awaited<ReturnType<ReturnType<typeof getConnection>["getTransaction"]>>
  >
> {
  const conn = getConnection();
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  // Small backoff loop — getTransaction returns null until the slot
  // containing the sig has finalized for the requested commitment.
  while (Date.now() < deadline) {
    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      if (tx.meta?.err) {
        throw new Error(
          `transaction ${signature} failed on-chain: ${JSON.stringify(tx.meta.err)}`,
        );
      }
      return tx;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timed out waiting for ${signature} to finalize`);
}

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

/**
 * Build, sign, send, and confirm a transaction packing multiple
 * instructions. Returns the confirmed signature.
 *
 * Use this for batch operations like `register_agent` × N during
 * kickoff: 1 fee, 1 confirmation, atomic ("all or nothing").
 *
 * Caller is responsible for staying under Solana's 1232-byte tx size
 * limit — chunk the instruction list at the call site if it's
 * unbounded. For register_agent that's roughly 6-8 ix per tx.
 */
export async function sendAndConfirmInstructions(args: {
  instructions: TransactionInstruction[];
  payer: Keypair;
  extraSigners?: Keypair[];
  priorityMicroLamports?: number;
}): Promise<string> {
  if (args.instructions.length === 0) {
    throw new Error("sendAndConfirmInstructions: empty instructions array");
  }
  const conn = getConnection();
  const tx = new Transaction();
  if (args.priorityMicroLamports !== undefined) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: args.priorityMicroLamports,
      }),
    );
  }
  for (const ix of args.instructions) tx.add(ix);

  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.payer.publicKey;

  const signers = [args.payer, ...(args.extraSigners ?? [])];
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
