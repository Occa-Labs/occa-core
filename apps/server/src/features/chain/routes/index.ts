import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  buildCreateCompanyInstruction,
  buildCreateDeploymentInstruction,
  buildRegisterAgentIdentityInstruction,
  buildSetOperatingWalletInstruction,
  deriveAgentIdentityPda,
  deriveCompanyPda,
  deriveDeploymentPda,
} from "occa-sdk";
import { Keypair } from "@solana/web3.js";
import {
  findById as findIdentityById,
  findOwnedByUserId as findOwnedIdentityByUserId,
  updateIdentityById,
} from "../../agents/repositories/agent-identities";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { findOwnedByUserId as findOwnedDeploymentByUserId } from "../../agents/repositories/deployments";
import { findById as findCompanyById } from "../../companies/repositories/companies";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import {
  accountExists,
  prepareOwnerSignedTx,
  submitSignedTx,
} from "../services/transaction";
import {
  nextAgentIndex,
  persistAgentChainRegistration,
  persistAgentOperatingWallet,
  persistCompanyChainRegistration,
  persistIdentityChainRegistration,
  reserveAgentIndex,
} from "../repositories/chain-registry";
import { findCompaniesForWallet } from "../services/chain-lookup";

const log = childLogger("routes:chain");

const router: Router = Router();

// ── Architecture (post-refactor) ────────────────────────────────────────────
// All state-changing instructions are signed by the user wallet (`owner`).
// The operator hot wallet is the fee-payer ONLY — it never appears as an
// authority in any account. The flow per ix:
//
//   1. POST /…/prepare   → BE assigns nonce/index, builds the ix, sets
//                          operator as fee-payer, partial-signs as
//                          fee-payer, and returns the base64 tx blob.
//   2. FE                → Wallet calls signTransaction() to add the owner
//                          signature, then sends the raw tx via RPC and
//                          captures the resulting signature string.
//   3. POST /…/confirm   → FE reports the signature. BE polls
//                          getTransaction() for the confirmed tx and
//                          persists the on-chain cache columns.

// ── Schemas ─────────────────────────────────────────────────────────────────

const prepareCompanyBody = z
  .object({
    metadataUri: z.string().max(200).optional(),
  })
  .strict();

const confirmCompanyBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    nonce: z.number().int().nonnegative(),
  })
  .strict();

const prepareAgentBody = z.object({}).strict();

const confirmAgentBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    agentIndex: z.number().int().nonnegative(),
  })
  .strict();

const prepareIdentityBody = z.object({}).strict();

const confirmIdentityBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    agentPubkey: z.string().min(32).max(48),
  })
  .strict();

const prepareSetOperatingWalletBody = z
  .object({
    operatingWallet: z.string().min(32).max(48),
  })
  .strict();

const confirmSetOperatingWalletBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    operatingWallet: z.string().min(32).max(48),
  })
  .strict();

// ── Helpers ─────────────────────────────────────────────────────────────────

function operatorOrFail(
  res: Response,
): ReturnType<typeof getOperatorKeypair> | null {
  try {
    return getOperatorKeypair();
  } catch (err) {
    log.error({ err }, "operator keypair unavailable");
    res
      .status(StatusCodes.SERVICE_UNAVAILABLE)
      .json({ error: ERROR_CODES.OPERATOR_NOT_CONFIGURED });
    return null;
  }
}

// ── Company ─────────────────────────────────────────────────────────────────

/**
 * POST /api/chain/companies/:companyId/register/prepare
 *
 * Pick the next free `nonce` for `(userWallet, *)`, build a
 * `create_company` instruction, partial-sign as fee-payer, and return
 * the base64 tx for the FE wallet to add the owner signature.
 *
 * Idempotent: if the company is already anchored, returns 200 with the
 * existing record (no tx). FE should treat the absence of `transaction`
 * as "skip the wallet popup".
 *
 * Recovery: probes chain for `(userWallet, nonce=0..N)`. Any hit
 * automatically backfills DB (the wallet is the seed AND the authority,
 * so no operator-rotation drift can happen).
 */
router.post(
  "/companies/:companyId/register/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = prepareCompanyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    if (company.companyPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        companyPda: company.companyPda,
        ownerWallet: company.ownerWallet,
        chainNonce: company.chainNonce,
      });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const metadataUri = parsed.data.metadataUri ?? "";
    const userWalletPk = new PublicKey(req.user!.walletAddress);

    // ── Chain-DB sync pre-check ───────────────────────────────────────
    // The wallet IS the seed AND the sole authority — any on-chain hit
    // is reusable for this user. Backfill DB instead of paying rent
    // for a duplicate.
    let chainCompanies: Awaited<ReturnType<typeof findCompaniesForWallet>> = [];
    try {
      chainCompanies = await findCompaniesForWallet(userWalletPk);
      const reusable = chainCompanies[0];
      if (reusable) {
        await persistCompanyChainRegistration({
          companyId,
          companyPda: reusable.companyPda.toBase58(),
          ownerWallet: reusable.owner.toBase58(),
          chainNonce: reusable.nonce,
          chainTxSignature: "",
        });
        log.info(
          {
            companyId,
            companyPda: reusable.companyPda.toBase58(),
            wallet: userWalletPk.toBase58(),
            chainNonce: reusable.nonce,
          },
          "company already registered on-chain; backfilled DB from chain",
        );
        res.status(StatusCodes.OK).json({
          alreadyRegistered: true,
          recoveredFromChain: true,
          companyPda: reusable.companyPda.toBase58(),
          ownerWallet: reusable.owner.toBase58(),
          chainNonce: reusable.nonce,
        });
        return;
      }
    } catch (err) {
      log.warn(
        { err, companyId },
        "chain-sync pre-check failed; continuing with fresh registration",
      );
    }

    // Pick an unused nonce.
    let nonce = 0;
    let companyPda: PublicKey | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const derived = deriveCompanyPda(userWalletPk, nonce);
      // eslint-disable-next-line no-await-in-loop
      const exists = await accountExists(derived.pda);
      if (!exists) {
        companyPda = derived.pda;
        break;
      }
      nonce += 1;
    }
    if (!companyPda) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    const { instruction } = buildCreateCompanyInstruction({
      owner: userWalletPk,
      payer: operator.publicKey,
      nonce,
      name: company.name,
      locale: company.locale ?? "",
      metadataUri,
      // SHA-256 of canonical metadata JSON, 32 bytes. Empty buffer when
      // metadata not yet finalized — chain accepts zeroes here.
      metadataHash: company.metadataHash
        ? Buffer.from(company.metadataHash, "hex")
        : Buffer.alloc(32),
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, companyId, nonce }, "create_company prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      companyPda: companyPda.toBase58(),
      ownerWallet: userWalletPk.toBase58(),
      chainNonce: nonce,
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/register/confirm
 *
 * FE has broadcast the wallet-signed tx and reports the signature. We
 * wait for confirmation, then persist the on-chain cache columns.
 */
router.post(
  "/companies/:companyId/register/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = confirmCompanyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { signedTransaction, blockhash, lastValidBlockHeight, nonce } =
      parsed.data;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    if (company.companyPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        companyPda: company.companyPda,
        ownerWallet: company.ownerWallet,
        chainNonce: company.chainNonce,
        chainTxSignature: company.chainTxSignature,
      });
      return;
    }

    const userWalletPk = new PublicKey(req.user!.walletAddress);
    const { pda: companyPda } = deriveCompanyPda(userWalletPk, nonce);

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: signedTransaction,
        blockhash,
        lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId }, "create_company submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Sanity: account must now exist on-chain at the predicted PDA.
    const exists = await accountExists(companyPda);
    if (!exists) {
      log.error(
        { companyId, signature, companyPda: companyPda.toBase58(), nonce },
        "create_company confirm: PDA not present after confirmation",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistCompanyChainRegistration({
      companyId,
      companyPda: companyPda.toBase58(),
      ownerWallet: userWalletPk.toBase58(),
      chainNonce: nonce,
      chainTxSignature: signature,
    });

    log.info(
      { companyId, companyPda: companyPda.toBase58(), nonce, signature },
      "company registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      companyPda: companyPda.toBase58(),
      ownerWallet: userWalletPk.toBase58(),
      chainNonce: nonce,
      chainTxSignature: signature,
    });
  },
);

// ── Agent Identity: register ────────────────────────────────────────────────
//
// `register_agent_identity` mints the portable AgentIdentity PDA used as
// the immutable seed for any future Deployment under any company owned
// by this wallet. Identity is independent of company — `create_deployment`
// requires this PDA to already exist on chain.
//
// The `agent_pubkey` baked into the PDA seed is a fresh keypair pubkey
// (NOT a signer in this ix — see SDK keys layout). We generate it
// server-side so the operator-as-fee-payer can pre-write the row before
// the user signs; the private key is discarded — only the pubkey is
// load-bearing as a stable identifier.

/**
 * POST /api/chain/agent-identities/:identityId/register/prepare
 *
 * Build a `register_agent_identity` instruction, partial-sign as
 * fee-payer, and return the base64 tx for the FE wallet to add the
 * owner signature. Pre-writes the freshly-generated `agent_pubkey` +
 * derived `identity_pda` to the row so confirm matches.
 *
 * Idempotent: real (non-placeholder) `identity_pda` short-circuits to
 * `alreadyRegistered: true`.
 */
router.post(
  "/agent-identities/:identityId/register/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const identityId = req.params.identityId;

    const parsed = prepareIdentityBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const identity = await findOwnedIdentityByUserId({ userId, identityId });
    if (!identity) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Real PDA already cached → nothing to do. Placeholder strings
    // (`ag_pda_<48hex>`) are NOT NULL by schema; parse-check filters
    // them out so we don't false-positive a "registered" identity.
    if (identity.identityPda) {
      try {
        const pk = new PublicKey(identity.identityPda);
        res.status(StatusCodes.OK).json({
          alreadyRegistered: true,
          identityPda: pk.toBase58(),
          agentPubkey: identity.agentPubkey,
        });
        return;
      } catch {
        // placeholder — fall through
      }
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const userWalletPk = new PublicKey(req.user!.walletAddress);

    // Generate a fresh agent_pubkey. Not a signer in the ix; we keep
    // only the pubkey for PDA derivation + future identity lookups.
    // Discarding the private key is intentional — there's no future ix
    // that needs it (owner wallet authorizes everything).
    const agentKeypair = Keypair.generate();
    const agentPubkey = agentKeypair.publicKey;
    const { pda: identityPda } = deriveAgentIdentityPda(agentPubkey);

    const { instruction } = buildRegisterAgentIdentityInstruction({
      agentPubkey,
      owner: userWalletPk,
      payer: operator.publicKey,
      name: identity.name,
      metadataUri: identity.metadataUri ?? "",
      metadataHash: identity.metadataHash
        ? Buffer.from(identity.metadataHash, "hex")
        : Buffer.alloc(32),
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error(
        { err, identityId },
        "register_agent_identity prepare failed",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Pre-write so a concurrent prepare for the same identity (race) hits
    // the parse-check above and short-circuits. Owner wallet + tx
    // signature land in the confirm step. Using `updateIdentityById`
    // keeps the create-time fields (name, metadata) untouched.
    await updateIdentityById({
      identityId,
      patch: {
        agentPubkey: agentPubkey.toBase58(),
        identityPda: identityPda.toBase58(),
      },
    });

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      identityPda: identityPda.toBase58(),
      agentPubkey: agentPubkey.toBase58(),
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/agent-identities/:identityId/register/confirm
 *
 * FE submits the wallet-signed tx; we broadcast, confirm, and persist
 * the chain-side cache columns (chain_tx_signature, owner_wallet).
 */
router.post(
  "/agent-identities/:identityId/register/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const identityId = req.params.identityId;

    const parsed = confirmIdentityBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { signedTransaction, blockhash, lastValidBlockHeight, agentPubkey } =
      parsed.data;

    const identity = await findOwnedIdentityByUserId({ userId, identityId });
    if (!identity) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Already on-chain (concurrent confirm) — return the cached fields.
    if (identity.identityPda) {
      try {
        const pk = new PublicKey(identity.identityPda);
        if (identity.chainTxSignature) {
          res.status(StatusCodes.OK).json({
            alreadyRegistered: true,
            identityPda: pk.toBase58(),
            agentPubkey: identity.agentPubkey,
            chainTxSignature: identity.chainTxSignature,
          });
          return;
        }
      } catch {
        // placeholder — proceed
      }
    }

    let agentPubkeyPk: PublicKey;
    try {
      agentPubkeyPk = new PublicKey(agentPubkey);
    } catch {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { pda: identityPda } = deriveAgentIdentityPda(agentPubkeyPk);
    const userWalletPk = new PublicKey(req.user!.walletAddress);

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: signedTransaction,
        blockhash,
        lastValidBlockHeight,
      });
    } catch (err) {
      log.error(
        { err, identityId },
        "register_agent_identity submit failed",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    const exists = await accountExists(identityPda);
    if (!exists) {
      log.error(
        {
          identityId,
          signature,
          identityPda: identityPda.toBase58(),
        },
        "register_agent_identity confirm: PDA not present after confirmation",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistIdentityChainRegistration({
      identityId,
      agentPubkey: agentPubkeyPk.toBase58(),
      identityPda: identityPda.toBase58(),
      ownerWallet: userWalletPk.toBase58(),
      chainTxSignature: signature,
    });

    log.info(
      { identityId, identityPda: identityPda.toBase58(), signature },
      "agent identity registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      identityPda: identityPda.toBase58(),
      agentPubkey: agentPubkeyPk.toBase58(),
      chainTxSignature: signature,
    });
  },
);

// ── Agent: register ─────────────────────────────────────────────────────────

/**
 * POST /api/chain/agents/:agentId/register/prepare
 *
 * Allocate an `agent_index`, build a `register_agent` ix, partial-sign
 * as fee-payer, return the base64 tx.
 *
 * Idempotent on already-registered agents (returns 200 with existing
 * record, no transaction).
 */
router.post(
  "/agents/:agentId/register/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = prepareAgentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const agent = await findOwnedDeploymentByUserId({
      userId,
      deploymentId: agentId,
    });
    if (!agent) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Treat as registered ONLY if the stored PDA parses as a real Solana
    // pubkey. Placeholder strings (`dep_pda_<48hex>`) are NOT NULL by
    // schema until the chain confirm step overwrites them, so a naive
    // truthy check would falsely report success and let the FE skip
    // signing — leaving the user with a "Done" UI but nothing on chain.
    if (agent.deploymentPda) {
      try {
        const pk = new PublicKey(agent.deploymentPda);
        res.status(StatusCodes.OK).json({
          alreadyRegistered: true,
          agentPda: pk.toBase58(),
          agentIndex: agent.deploymentIndex,
        });
        return;
      } catch {
        // Placeholder — fall through to the prepare-tx path below.
      }
    }

    const companyRow = await findCompanyById(agent.companyId);
    if (!companyRow || !companyRow.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const userWalletPk = new PublicKey(req.user!.walletAddress);
    const companyPda = new PublicKey(companyRow.companyPda);

    // create_deployment requires the AgentIdentity PDA — that PDA must
    // already exist on chain (registered via register_agent_identity in
    // a separate flow). The deployment row stores the identity FK; load
    // it here to get the on-chain PDA string.
    const identityRow = await findIdentityById(agent.agentIdentityId);
    if (!identityRow?.identityPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    let identityPda: PublicKey;
    try {
      identityPda = new PublicKey(identityRow.identityPda);
    } catch {
      // Placeholder identity_pda from pre-chain deployment — block until
      // identity is registered on-chain. Caller should run the identity
      // registration flow first.
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Pick a free deployment_index. Prefer the row's reserved index if any.
    let agentIndex =
      agent.deploymentIndex ?? (await nextAgentIndex(agent.companyId));
    let agentPda: PublicKey | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const probe = deriveDeploymentPda(companyPda, agentIndex);
      // eslint-disable-next-line no-await-in-loop
      const exists = await accountExists(probe.pda);
      if (!exists) {
        agentPda = probe.pda;
        break;
      }
      agentIndex += 1;
    }
    if (!agentPda) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Pin the index on the row so confirm can't drift.
    if (agent.deploymentIndex !== agentIndex) {
      await reserveAgentIndex({ agentId, agentIndex });
    }

    const { instruction } = buildCreateDeploymentInstruction({
      companyPda,
      identityPda,
      owner: userWalletPk,
      payer: operator.publicKey,
      deploymentIndex: agentIndex,
      role: agent.role,
      parentDeploymentIndex: agent.parentDeploymentIndex ?? null,
      adapterId: PublicKey.default,
      metadataUri: "",
      metadataHash: Buffer.alloc(32),
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, agentId, agentIndex }, "register_agent prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      agentPda: agentPda.toBase58(),
      agentIndex,
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/agents/:agentId/register/confirm
 *
 * FE has broadcast the wallet-signed register_agent tx. Persist on
 * confirmation.
 */
router.post(
  "/agents/:agentId/register/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = confirmAgentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { signedTransaction, blockhash, lastValidBlockHeight, agentIndex } =
      parsed.data;

    const agent = await findOwnedDeploymentByUserId({
      userId,
      deploymentId: agentId,
    });
    if (!agent) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    if (agent.deploymentPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        agentPda: agent.deploymentPda,
        agentIndex: agent.deploymentIndex,
        agentChainTxSignature: agent.chainTxSignature,
      });
      return;
    }

    const companyRow = await findCompanyById(agent.companyId);
    if (!companyRow || !companyRow.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    const userWalletPk = new PublicKey(req.user!.walletAddress);
    const companyPda = new PublicKey(companyRow.companyPda);
    const { pda: agentPda } = deriveDeploymentPda(companyPda, agentIndex);

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: signedTransaction,
        blockhash,
        lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, agentId }, "register_agent submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    const exists = await accountExists(agentPda);
    if (!exists) {
      log.error(
        { agentId, signature, agentPda: agentPda.toBase58(), agentIndex },
        "register_agent confirm: PDA not present after confirmation",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistAgentChainRegistration({
      agentId,
      agentPda: agentPda.toBase58(),
      agentIndex,
      ownerWallet: userWalletPk.toBase58(),
      agentChainTxSignature: signature,
    });

    log.info(
      { agentId, agentPda: agentPda.toBase58(), agentIndex, signature },
      "agent registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      agentPda: agentPda.toBase58(),
      agentIndex,
      ownerWallet: userWalletPk.toBase58(),
      agentChainTxSignature: signature,
    });
  },
);

// ── Agent: set_operating_wallet ─────────────────────────────────────────────

/**
 * POST /api/chain/agents/:agentId/operating-wallet/prepare
 *
 * Build a `set_operating_wallet` ix targeting an already-anchored agent.
 * The agent's `owner` (= user wallet) signs in the browser.
 */
router.post(
  "/agents/:agentId/operating-wallet/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = prepareSetOperatingWalletBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    let newOperatingWallet: PublicKey;
    try {
      newOperatingWallet = new PublicKey(parsed.data.operatingWallet);
    } catch {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const agent = await findOwnedDeploymentByUserId({
      userId,
      deploymentId: agentId,
    });
    if (!agent) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }
    if (!agent.deploymentPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const userWalletPk = new PublicKey(req.user!.walletAddress);
    const { instruction } = buildSetOperatingWalletInstruction({
      deploymentPda: new PublicKey(agent.deploymentPda),
      owner: userWalletPk,
      newOperatingWallet,
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, agentId }, "set_operating_wallet prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      operatingWallet: newOperatingWallet.toBase58(),
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/agents/:agentId/operating-wallet/confirm
 *
 * Persist the new operating_wallet after the FE-broadcast tx confirms.
 */
router.post(
  "/agents/:agentId/operating-wallet/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = confirmSetOperatingWalletBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const {
      signedTransaction,
      blockhash,
      lastValidBlockHeight,
      operatingWallet,
    } = parsed.data;

    let newOperatingWallet: PublicKey;
    try {
      newOperatingWallet = new PublicKey(operatingWallet);
    } catch {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    const agent = await findOwnedDeploymentByUserId({
      userId,
      deploymentId: agentId,
    });
    if (!agent || !agent.deploymentPda) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: signedTransaction,
        blockhash,
        lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, agentId }, "set_operating_wallet submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistAgentOperatingWallet({
      agentId,
      operatingWallet: newOperatingWallet.toBase58(),
    });

    log.info(
      {
        agentId,
        agentPda: agent.deploymentPda,
        operatingWallet: newOperatingWallet.toBase58(),
        signature,
      },
      "agent operating_wallet updated",
    );

    res.status(StatusCodes.OK).json({
      operatingWallet: newOperatingWallet.toBase58(),
      signature,
    });
  },
);

export default router;
