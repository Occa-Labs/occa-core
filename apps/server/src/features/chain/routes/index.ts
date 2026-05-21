import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  buildCreateCompanyInstruction,
  buildCreateDeploymentInstruction,
  buildRegisterAgentIdentityInstruction,
  buildSetReceivingAddressInstruction,
  buildSetPolicyInstruction,
  buildDisburseDiscretionaryInstruction,
  deriveAgentIdentityPda,
  deriveCompanyPda,
  deriveDeploymentPda,
  deriveTreasuryPda,
  derivePolicyPda,
  SOL_PSEUDO_MINT,
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
import { fetchTreasuryState } from "../services/treasury-lookup";
import { buildDisbursementPlan } from "../../billing/services/disbursement";
import { markInvoicesPaid } from "../../billing/repositories/invoices";

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

// Combined identity + deployment registration in a single tx — used by
// the kickoff batch flow to keep wallet popups at 1-per-agent (vs 2 per
// agent if we ran identity + deployment as separate signatures).
const prepareCombinedAgentBody = z.object({}).strict();

const confirmCombinedAgentBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    agentPubkey: z.string().min(32).max(48),
    agentIndex: z.number().int().nonnegative(),
  })
  .strict();

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

const prepareSetPolicyBody = z
  .object({
    // SOL discretionary budget per calendar month, in lamports.
    discretionaryBudgetLamports: z.number().int().min(0),
  })
  .strict();

const confirmSetPolicyBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
  })
  .strict();

const confirmDisbursementBody = z
  .object({
    signedTransaction: z.string().min(1),
    blockhash: z.string().min(32).max(64),
    lastValidBlockHeight: z.number().int().nonnegative(),
    invoiceIds: z.array(z.string().uuid()).min(1),
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

// One `disburse_discretionary` ix per payable agent. A Solana tx caps at
// ~1232 bytes; each ix is ~280 bytes, so ~6 agents is the safe ceiling
// for a single-tx batch. Beyond that the FE would need to split — out of
// scope for Phase 1c-ii.
const MAX_DISBURSEMENT_AGENTS = 6;

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

    // Real PDA already cached AND actually present on chain → nothing
    // to do. Both checks needed: parse-check filters out `ag_pda_<hex>`
    // placeholders, and the chain check filters out leftover pre-writes
    // from a previous prepare that was never signed (DB cache looks
    // real but chain is empty — re-prepare must mint a new keypair).
    if (identity.identityPda) {
      try {
        const pk = new PublicKey(identity.identityPda);
        if (await accountExists(pk)) {
          res.status(StatusCodes.OK).json({
            alreadyRegistered: true,
            identityPda: pk.toBase58(),
            agentPubkey: identity.agentPubkey,
          });
          return;
        }
        // pre-write leftover — fall through to fresh prepare
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

    // Same parse-check pattern as the prepare side — placeholder
    // strings (`dep_pda_<48hex>`) would otherwise silently short-circuit
    // confirm and report success without broadcasting the signed tx.
    if (agent.deploymentPda) {
      try {
        const pk = new PublicKey(agent.deploymentPda);
        res.status(StatusCodes.OK).json({
          alreadyRegistered: true,
          agentPda: pk.toBase58(),
          agentIndex: agent.deploymentIndex,
          agentChainTxSignature: agent.chainTxSignature,
        });
        return;
      } catch {
        /* placeholder — proceed with confirm */
      }
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

// ── Agent: register-combined (identity + deployment) ───────────────────────
//
// Single-signature variant of the identity → deployment chain. Combines
// `register_agent_identity` + `create_deployment` into one Solana tx so
// the kickoff batch flow only needs N signatures for N hires (instead
// of 2N if identity + deployment ran separately).
//
// Tx size budget: each ix is small (<200 bytes incl. metadata strings).
// Two ixs + signatures fit comfortably within Solana's 1232-byte cap
// for typical inputs (role string, empty metadata uri).
//
// Skips the identity-half if the row already has a real identity_pda
// (re-deployment of a portable identity to a new company under the
// same wallet — Phase-2 territory; today every deployment also creates
// a fresh identity).

/**
 * POST /api/chain/agents/:agentId/register-combined/prepare
 *
 * Builds one tx that registers the AgentIdentity (if not yet on chain)
 * AND creates the Deployment. Pre-writes both PDAs to DB so confirm can
 * match. Idempotent: real (non-placeholder) deployment_pda short-circuits
 * to `alreadyRegistered: true`.
 */
router.post(
  "/agents/:agentId/register-combined/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = prepareCombinedAgentBody.safeParse(req.body ?? {});
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

    // Short-circuit if the deployment_pda is already a real Solana
    // pubkey. Placeholder strings (`dep_pda_<48hex>`) are NOT NULL by
    // schema; parse-check filters them so we don't false-positive.
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
        /* placeholder — fall through */
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

    const identityRow = await findIdentityById(agent.agentIdentityId);
    if (!identityRow) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Decide whether the identity needs to be created in this tx.
    // Trust the DB row ONLY when the PDA actually exists on chain —
    // a previous prepare may have pre-written the row but the user
    // never signed, leaving the DB looking "real" while chain is empty.
    // Without the chain check, the deployment ix would fail at runtime
    // because its required identity PDA doesn't exist.
    let identityPda: PublicKey;
    let agentPubkey: PublicKey;
    let needsIdentityIx = true;
    if (identityRow.identityPda) {
      try {
        const candidatePda = new PublicKey(identityRow.identityPda);
        const candidatePubkey = new PublicKey(identityRow.agentPubkey);
        if (await accountExists(candidatePda)) {
          identityPda = candidatePda;
          agentPubkey = candidatePubkey;
          needsIdentityIx = false;
        } else {
          // DB has placeholder-or-leftover values but chain is empty.
          // Mint a fresh keypair so the prepared tx actually creates
          // the identity.
          const fresh = Keypair.generate();
          agentPubkey = fresh.publicKey;
          identityPda = deriveAgentIdentityPda(agentPubkey).pda;
        }
      } catch {
        // Placeholder string — fresh keypair below.
        const fresh = Keypair.generate();
        agentPubkey = fresh.publicKey;
        identityPda = deriveAgentIdentityPda(agentPubkey).pda;
      }
    } else {
      const fresh = Keypair.generate();
      agentPubkey = fresh.publicKey;
      identityPda = deriveAgentIdentityPda(agentPubkey).pda;
    }

    // Allocate a free deployment_index. Same probe-loop as the legacy
    // single-ix path so behaviour matches.
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

    if (agent.deploymentIndex !== agentIndex) {
      await reserveAgentIndex({ agentId, agentIndex });
    }

    const instructions = [];
    if (needsIdentityIx) {
      const { instruction: identityIx } = buildRegisterAgentIdentityInstruction(
        {
          agentPubkey,
          owner: userWalletPk,
          payer: operator.publicKey,
          name: identityRow.name,
          metadataUri: identityRow.metadataUri ?? "",
          metadataHash: identityRow.metadataHash
            ? Buffer.from(identityRow.metadataHash, "hex")
            : Buffer.alloc(32),
        },
      );
      instructions.push(identityIx);
    }
    const { instruction: deploymentIx } = buildCreateDeploymentInstruction({
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
    instructions.push(deploymentIx);

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions,
        feePayer: operator,
      });
    } catch (err) {
      log.error(
        { err, agentId, agentIndex },
        "register-combined prepare failed",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Pre-write identity row (if it'll be created in this tx) so a
    // racing prepare hits the parse-check above and short-circuits.
    if (needsIdentityIx) {
      await updateIdentityById({
        identityId: identityRow.id,
        patch: {
          agentPubkey: agentPubkey.toBase58(),
          identityPda: identityPda.toBase58(),
        },
      });
    }

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      identityPda: identityPda.toBase58(),
      agentPubkey: agentPubkey.toBase58(),
      agentPda: agentPda.toBase58(),
      agentIndex,
      includesIdentity: needsIdentityIx,
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/agents/:agentId/register-combined/confirm
 *
 * Submit the wallet-signed combined tx, verify both PDAs exist on
 * chain, and persist chain_tx_signature on identity + deployment.
 */
router.post(
  "/agents/:agentId/register-combined/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const agentId = req.params.agentId;

    const parsed = confirmCombinedAgentBody.safeParse(req.body ?? {});
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
      agentPubkey,
      agentIndex,
    } = parsed.data;

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

    // Parse-check: real PDA already cached → racing confirm short-circuits.
    if (agent.deploymentPda) {
      try {
        const pk = new PublicKey(agent.deploymentPda);
        res.status(StatusCodes.OK).json({
          alreadyRegistered: true,
          agentPda: pk.toBase58(),
          agentIndex: agent.deploymentIndex,
          agentChainTxSignature: agent.chainTxSignature,
        });
        return;
      } catch {
        /* placeholder — proceed */
      }
    }

    const companyRow = await findCompanyById(agent.companyId);
    if (!companyRow || !companyRow.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
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

    const userWalletPk = new PublicKey(req.user!.walletAddress);
    const companyPda = new PublicKey(companyRow.companyPda);
    const { pda: identityPda } = deriveAgentIdentityPda(agentPubkeyPk);
    const { pda: agentPda } = deriveDeploymentPda(companyPda, agentIndex);

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: signedTransaction,
        blockhash,
        lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, agentId }, "register-combined submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Verify both PDAs landed. The combined tx must have produced
    // identity + deployment atomically; either both exist or neither.
    const [identityExists, deploymentExists] = await Promise.all([
      accountExists(identityPda),
      accountExists(agentPda),
    ]);
    if (!identityExists || !deploymentExists) {
      log.error(
        {
          agentId,
          signature,
          identityPda: identityPda.toBase58(),
          agentPda: agentPda.toBase58(),
          identityExists,
          deploymentExists,
        },
        "register-combined confirm: PDAs missing after confirmation",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Persist both halves. Identity gets its chain_tx_signature; the
    // deployment row gets the same signature (one tx covered both ix).
    await persistIdentityChainRegistration({
      identityId: agent.agentIdentityId,
      agentPubkey: agentPubkeyPk.toBase58(),
      identityPda: identityPda.toBase58(),
      ownerWallet: userWalletPk.toBase58(),
      chainTxSignature: signature,
    });
    await persistAgentChainRegistration({
      agentId,
      agentPda: agentPda.toBase58(),
      agentIndex,
      ownerWallet: userWalletPk.toBase58(),
      agentChainTxSignature: signature,
    });

    log.info(
      {
        agentId,
        identityPda: identityPda.toBase58(),
        agentPda: agentPda.toBase58(),
        agentIndex,
        signature,
      },
      "agent identity + deployment registered on-chain (combined)",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      identityPda: identityPda.toBase58(),
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
    const { instruction } = buildSetReceivingAddressInstruction({
      deploymentPda: new PublicKey(agent.deploymentPda),
      owner: userWalletPk,
      newReceivingAddress: newOperatingWallet,
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

// ── Treasury ────────────────────────────────────────────────────────────────

/**
 * GET /api/chain/companies/:companyId/treasury
 *
 * Read the company's on-chain treasury state — TreasuryAccount balance +
 * PolicyAccount budgets/fee. Pure chain read; no tx.
 */
router.get(
  "/companies/:companyId/treasury",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      // Company not anchored on chain yet — no treasury exists.
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }

    let state: Awaited<ReturnType<typeof fetchTreasuryState>>;
    try {
      state = await fetchTreasuryState(new PublicKey(company.companyPda));
    } catch (err) {
      log.error({ err, companyId }, "treasury state read failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.UPSTREAM_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      treasuryPda: state.treasuryPda,
      policyPda: state.policyPda,
      balanceLamports: state.balanceLamports,
      initialized: state.initialized,
      // bigint → string — JSON can't carry bigint, FE parses back.
      discretionaryBudgetLamports: state.discretionaryBudgetLamports.toString(),
      discretionarySpentLamports: state.discretionarySpentLamports.toString(),
      agentOperatingFeeBps: state.agentOperatingFeeBps,
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/treasury/policy/prepare
 *
 * Build a `set_policy` ix that writes the SOL discretionary budget. The
 * company owner (controlling authority) signs in the browser.
 */
router.post(
  "/companies/:companyId/treasury/policy/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = prepareSetPolicyBody.safeParse(req.body ?? {});
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
    if (!company.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const companyPda = new PublicKey(company.companyPda);
    const { instruction } = buildSetPolicyInstruction({
      companyPda,
      treasuryPda: deriveTreasuryPda(companyPda).pda,
      policyPda: derivePolicyPda(companyPda).pda,
      controllingAuthority: new PublicKey(req.user!.walletAddress),
      discretionaryBudgetPerMonth: [
        {
          mint: SOL_PSEUDO_MINT,
          amount: BigInt(parsed.data.discretionaryBudgetLamports),
        },
      ],
    });

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions: [instruction],
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, companyId }, "set_policy prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/treasury/policy/confirm
 *
 * Broadcast the owner-signed `set_policy` tx. No DB cache — treasury
 * state is read live from chain on the next GET.
 */
router.post(
  "/companies/:companyId/treasury/policy/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = confirmSetPolicyBody.safeParse(req.body ?? {});
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

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: parsed.data.signedTransaction,
        blockhash: parsed.data.blockhash,
        lastValidBlockHeight: parsed.data.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId }, "set_policy submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    log.info({ companyId, signature }, "treasury policy updated");
    res.status(StatusCodes.OK).json({ signature });
  },
);

// ── Disbursements (Phase 1c-ii) ─────────────────────────────────────────────

/**
 * GET /api/chain/companies/:companyId/disbursements/pending
 *
 * The pending-disbursement plan: pending invoices grouped per agent,
 * plus treasury balance / budget headroom so the UI can warn before a
 * run that would revert.
 */
router.get(
  "/companies/:companyId/disbursements/pending",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }

    const plan = await buildDisbursementPlan(companyId);

    let treasury: Awaited<ReturnType<typeof fetchTreasuryState>> | null = null;
    try {
      treasury = await fetchTreasuryState(new PublicKey(company.companyPda));
    } catch (err) {
      log.warn({ err, companyId }, "treasury read failed during plan fetch");
    }

    const feeBps = treasury?.agentOperatingFeeBps ?? 0;
    const estimatedFee = Math.floor((plan.totalLamports * feeBps) / 10_000);

    res.status(StatusCodes.OK).json({
      payable: plan.payable.map((a) => ({
        deploymentId: a.deploymentId,
        agentName: a.agentName,
        receivingAddress: a.receivingAddress,
        invoiceCount: a.invoiceIds.length,
        totalLamports: a.totalLamports,
      })),
      blocked: plan.blocked,
      totalLamports: plan.totalLamports,
      estimatedFeeLamports: estimatedFee,
      feeBps,
      treasuryBalanceLamports: treasury?.balanceLamports ?? 0,
      budgetRemainingLamports: treasury
        ? (
            treasury.discretionaryBudgetLamports -
            treasury.discretionarySpentLamports
          ).toString()
        : "0",
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/disbursements/prepare
 *
 * Build a batched tx — one `disburse_discretionary` ix per payable agent
 * (paying the sum of their pending invoices). The company owner signs in
 * the browser. Returns the flat invoice-id list so `confirm` knows which
 * rows to settle.
 */
router.post(
  "/companies/:companyId/disbursements/prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    if (!company.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.CHAIN_NOT_ANCHORED });
      return;
    }

    const plan = await buildDisbursementPlan(companyId);
    if (plan.payable.length === 0) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.NOTHING_TO_DISBURSE });
      return;
    }
    if (plan.payable.length > MAX_DISBURSEMENT_AGENTS) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.DISBURSEMENT_BATCH_TOO_LARGE });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const companyPda = new PublicKey(company.companyPda);
    const treasuryPda = deriveTreasuryPda(companyPda).pda;
    const policyPda = derivePolicyPda(companyPda).pda;
    const controllingAuthority = new PublicKey(req.user!.walletAddress);

    let instructions;
    try {
      instructions = plan.payable.map(
        (a) =>
          buildDisburseDiscretionaryInstruction({
            companyPda,
            treasuryPda,
            policyPda,
            controllingAuthority,
            deploymentPda: new PublicKey(a.deploymentPda),
            destination: new PublicKey(a.receivingAddress),
            amountLamports: BigInt(a.totalLamports),
          }).instruction,
      );
    } catch (err) {
      log.error({ err, companyId }, "disbursement ix build failed");
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    let prepared: Awaited<ReturnType<typeof prepareOwnerSignedTx>>;
    try {
      prepared = await prepareOwnerSignedTx({
        instructions,
        feePayer: operator,
      });
    } catch (err) {
      log.error({ err, companyId }, "disbursement prepare failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      transaction: prepared.transactionBase64,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      // Flat list of every invoice the signed tx settles.
      invoiceIds: plan.payable.flatMap((a) => a.invoiceIds),
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/disbursements/confirm
 *
 * Broadcast the owner-signed batch, then settle the invoices it covered —
 * flip `pending` → `paid` + stamp the tx signature.
 */
router.post(
  "/companies/:companyId/disbursements/confirm",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = confirmDisbursementBody.safeParse(req.body ?? {});
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

    let signature: string;
    try {
      signature = await submitSignedTx({
        signedTransactionBase64: parsed.data.signedTransaction,
        blockhash: parsed.data.blockhash,
        lastValidBlockHeight: parsed.data.lastValidBlockHeight,
      });
    } catch (err) {
      log.error({ err, companyId }, "disbursement submit failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    // Tx confirmed on chain — settle the invoices it paid.
    const paidCount = await markInvoicesPaid(
      parsed.data.invoiceIds,
      signature,
    );
    log.info(
      { companyId, signature, paidCount },
      "disbursement settled — invoices marked paid",
    );

    res.status(StatusCodes.OK).json({ signature, paidCount });
  },
);

export default router;
