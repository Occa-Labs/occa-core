#!/usr/bin/env tsx
/**
 * Library-level smoke test for @occa/protocol against devnet.
 *
 * NO server, NO database — just the SDK exports + Solana RPC. This
 * script is the closest analogue to "what a third-party FE consumer
 * would write" once @occa/protocol ships to npm.
 *
 * Validates:
 *   - createCompany instruction lands on-chain & PDA matches derivation
 *   - registerAgent instruction lands on-chain & PDA matches derivation
 *   - sign-to-derive is deterministic across signs
 *   - canonical derivation message round-trips through ed25519 verify
 *
 * Requirements:
 *   - Operator keypair at ~/.config/solana/id.json with devnet SOL
 *     (the same keypair used to deploy programs/registry)
 *   - SOLANA_RPC_URL env (optional, defaults to public devnet)
 *
 * Run from packages/protocol/:
 *   pnpm devnet-smoke
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as ed from "@noble/ed25519";

import {
  buildAgentDerivationMessage,
  buildCreateCompanyInstruction,
  buildRegisterAgentInstruction,
  CURRENT_DERIVATION_MSG_VERSION,
  CUSTODY_MODEL_ON_CHAIN,
  deriveAgentKeypairFromSignature,
  deriveAgentPda,
  deriveCompanyPda,
  encodeDerivationMessage,
  REGISTRY_PROGRAM_ID,
} from "../src/index";

const RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

function loadOperator(): Keypair {
  const path =
    process.env.OPERATOR_KEYPAIR_PATH ??
    join(homedir(), ".config", "solana", "id.json");
  const raw = readFileSync(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function explorer(sig: string): string {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

async function submit(
  conn: Connection,
  payer: Keypair,
  ix: ReturnType<typeof buildCreateCompanyInstruction>["instruction"],
): Promise<string> {
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
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

async function main(): Promise<void> {
  const conn = new Connection(RPC_URL, "confirmed");
  const operator = loadOperator();
  const userWallet = Keypair.generate();

  console.log(`[smoke] rpc          = ${RPC_URL}`);
  console.log(`[smoke] program      = ${REGISTRY_PROGRAM_ID.toBase58()}`);
  console.log(`[smoke] operator     = ${operator.publicKey.toBase58()}`);
  console.log(`[smoke] user wallet  = ${userWallet.publicKey.toBase58()}`);

  const balance = await conn.getBalance(operator.publicKey, "confirmed");
  console.log(`[smoke] operator bal = ${balance / 1e9} SOL`);
  assert(balance > 0.01 * 1e9, "operator needs >= 0.01 SOL on devnet");

  // ── 1. Pick a fresh nonce ───────────────────────────────────────
  // Use lower 32 bits of unix-second timestamp; collision-resistant
  // enough for a smoke test without DB lookups.
  const nonce = Math.floor(Date.now() / 1000) & 0xffffffff;
  console.log(`[smoke] nonce        = ${nonce}`);

  // ── 2. create_company ───────────────────────────────────────────
  const expectedCompanyPda = deriveCompanyPda(operator.publicKey, nonce);
  const createIx = buildCreateCompanyInstruction({
    authority: operator.publicKey,
    payer: operator.publicKey,
    nonce,
    metadataUri: "smoke://devnet",
  });
  assert(
    createIx.companyPda.equals(expectedCompanyPda.pda),
    "instruction builder PDA mismatch (company)",
  );

  console.log(`[smoke] submitting create_company …`);
  const createSig = await submit(conn, operator, createIx.instruction);
  console.log(`[smoke]   companyPda = ${createIx.companyPda.toBase58()}`);
  console.log(`[smoke]   tx         = ${explorer(createSig)}`);

  const compInfo = await conn.getAccountInfo(createIx.companyPda, "confirmed");
  assert(compInfo !== null, "companyPda not on-chain after confirm");
  assert(
    compInfo.owner.equals(REGISTRY_PROGRAM_ID),
    `companyPda owner mismatch: ${compInfo.owner.toBase58()}`,
  );

  // ── 3. derivation determinism ───────────────────────────────────
  const agentIndex = 0;
  const msg = encodeDerivationMessage({
    companyPda: createIx.companyPda.toBase58(),
    agentIndex,
    version: CURRENT_DERIVATION_MSG_VERSION,
  });
  const userSeed = userWallet.secretKey.slice(0, 32);
  const sig1 = await ed.signAsync(msg, userSeed);
  const sig2 = await ed.signAsync(msg, userSeed);
  assert(
    Buffer.from(sig1).equals(Buffer.from(sig2)),
    "ed25519 signatures should be deterministic",
  );
  const kp1 = deriveAgentKeypairFromSignature(sig1);
  const kp2 = deriveAgentKeypairFromSignature(sig2);
  assert(
    kp1.publicKey.equals(kp2.publicKey),
    "derived agent pubkey not deterministic",
  );
  console.log(
    `[smoke] derived agent= ${kp1.publicKey.toBase58()} (deterministic ✓)`,
  );

  // ── 4. signature verify (mirrors server) ────────────────────────
  const ok = await ed.verifyAsync(sig1, msg, userWallet.publicKey.toBytes());
  assert(ok, "valid signature must verify");
  const tampered = new Uint8Array(sig1);
  tampered[0] ^= 0xff;
  const bad = await ed.verifyAsync(
    tampered,
    msg,
    userWallet.publicKey.toBytes(),
  );
  assert(!bad, "tampered signature must not verify");
  console.log(`[smoke] verify ok ✓ / tamper rejected ✓`);

  // sanity: string builder must equal byte encoder, byte-for-byte
  const messageStr = buildAgentDerivationMessage({
    companyPda: createIx.companyPda.toBase58(),
    agentIndex,
    version: CURRENT_DERIVATION_MSG_VERSION,
  });
  assert(
    Buffer.from(new TextEncoder().encode(messageStr)).equals(Buffer.from(msg)),
    "buildAgentDerivationMessage / encodeDerivationMessage drift",
  );

  // ── 5. register_agent ───────────────────────────────────────────
  const expectedAgentPda = deriveAgentPda(createIx.companyPda, agentIndex);
  const registerIx = buildRegisterAgentInstruction({
    companyPda: createIx.companyPda,
    controllingAuthority: operator.publicKey,
    payer: operator.publicKey,
    agentIndex,
    agentAddress: kp1.publicKey,
    custodyModel: CUSTODY_MODEL_ON_CHAIN.SignToDerive,
    roleId: 0,
    adapterId: PublicKey.default,
  });
  assert(
    registerIx.agentPda.equals(expectedAgentPda.pda),
    "instruction builder PDA mismatch (agent)",
  );

  console.log(`[smoke] submitting register_agent …`);
  const registerSig = await submit(conn, operator, registerIx.instruction);
  console.log(`[smoke]   agentPda   = ${registerIx.agentPda.toBase58()}`);
  console.log(`[smoke]   tx         = ${explorer(registerSig)}`);

  const agentInfo = await conn.getAccountInfo(registerIx.agentPda, "confirmed");
  assert(agentInfo !== null, "agentPda not on-chain after confirm");
  assert(
    agentInfo.owner.equals(REGISTRY_PROGRAM_ID),
    `agentPda owner mismatch: ${agentInfo.owner.toBase58()}`,
  );

  console.log(`[smoke] ✅ all checks passed`);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exitCode = 1;
});
