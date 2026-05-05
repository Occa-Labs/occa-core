import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  buildAgentDerivationMessage,
  buildBatchDerivationMessage,
  buildCreateCompanyInstruction,
  buildRegisterAgentInstruction,
  CURRENT_DERIVATION_MSG_VERSION,
  custodyModelStringToU8,
  CUSTODY_MODEL,
  deriveCompanyPda,
} from "occa-sdk";
import { childLogger } from "../../../lib/logger";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { findOwnedByUserId as findOwnedAgentByUserId } from "../../agents/repositories/agents";
import { findById as findCompanyById } from "../../companies/repositories/companies";
import { getOperatorKeypair } from "../../../infra/solana/operator-signer";
import { verifySolanaSignature } from "../../../infra/solana/verify";
import {
  accountExists,
  sendAndConfirmInstruction,
  sendAndConfirmInstructions,
} from "../services/transaction";
import {
  nextAgentIndex,
  nextChainNonce,
  persistAgentChainRegistration,
  persistCompanyChainRegistration,
  reserveAgentIndex,
} from "../repositories/chain-registry";
import { fetchCompany, findAgentByWallet } from "../services/chain-lookup";

const log = childLogger("routes:chain");

const router: Router = Router();

// ── Schemas ─────────────────────────────────────────────────────────────────

const registerCompanyBody = z
  .object({
    metadataUri: z.string().max(200).optional(),
  })
  .strict();

const registerAgentBody = z
  .object({
    agentAddress: z.string().min(32).max(64),
    derivationSignature: z.string().min(64).max(128),
    derivationMessageVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

const batchRegisterAgentsBody = z
  .object({
    derivationSignature: z.string().min(64).max(128),
    derivationMessageVersion: z.number().int().nonnegative().optional(),
    hires: z
      .array(
        z
          .object({
            agentId: z.string().min(1).max(64),
            agentAddress: z.string().min(32).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

const batchPrepareAgentsBody = z
  .object({
    agentIds: z.array(z.string().min(1).max(64)).min(1).max(16),
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

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/chain/companies/:companyId/register
 *
 * Register the caller's company on-chain (create_company). Operator hot
 * wallet acts as `controlling_authority` + payer for MVP. Idempotent: if
 * the company already has `company_pda` set, returns 200 with existing
 * record.
 */
router.post(
  "/companies/:companyId/register",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = registerCompanyBody.safeParse(req.body ?? {});
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
        controllingAuthority: company.controllingAuthority,
        chainNonce: company.chainNonce,
        chainTxSignature: company.chainTxSignature,
      });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const authority = operator.publicKey;
    const metadataUri = parsed.data.metadataUri ?? "";

    // ── Chain-DB sync pre-check ───────────────────────────────────────
    // The DB row may be empty after a fresh user / dev reset, but an
    // on-chain agent owned by this wallet may already exist. Scan chain
    // for any AgentAccount whose `agent_address` == userWallet → if
    // found, derive the owning company + nonce and **backfill** the DB
    // instead of creating a duplicate on-chain company. Keeps DB
    // authoritative-but-derived from chain.
    //
    // Reuse condition: the on-chain company's controlling_authority must
    // match our current operator pubkey. Mismatched authority means we
    // can't sign new instructions against it (ROLE_NOT_ALLOWED on chain),
    // so the only safe path is creating a fresh company under the
    // current operator. We log a warning so ops can spot operator key
    // rotation drift.
    try {
      const userWalletPk = new PublicKey(req.user!.walletAddress);
      const onChainAgent = await findAgentByWallet(userWalletPk);
      if (onChainAgent) {
        const onChainCompany = await fetchCompany(onChainAgent.company);
        if (
          onChainCompany &&
          onChainCompany.controllingAuthority.equals(authority)
        ) {
          await persistCompanyChainRegistration({
            companyId,
            companyPda: onChainCompany.companyPda.toBase58(),
            controllingAuthority:
              onChainCompany.controllingAuthority.toBase58(),
            chainNonce: onChainCompany.nonce,
            // No tx signature available — not from this server invocation.
            // Empty string is preferred over null so the column stays
            // typed-text and downstream code never has to nullcheck.
            chainTxSignature: "",
          });
          log.info(
            {
              companyId,
              companyPda: onChainCompany.companyPda.toBase58(),
              wallet: userWalletPk.toBase58(),
              chainNonce: onChainCompany.nonce,
            },
            "company already registered on-chain; backfilled DB from chain",
          );
          res.status(StatusCodes.OK).json({
            alreadyRegistered: true,
            recoveredFromChain: true,
            companyPda: onChainCompany.companyPda.toBase58(),
            controllingAuthority:
              onChainCompany.controllingAuthority.toBase58(),
            chainNonce: onChainCompany.nonce,
            chainTxSignature: null,
          });
          return;
        }
        if (onChainCompany) {
          log.warn(
            {
              wallet: userWalletPk.toBase58(),
              chainAuthority: onChainCompany.controllingAuthority.toBase58(),
              currentOperator: authority.toBase58(),
            },
            "wallet has on-chain agent under a different operator; creating fresh company",
          );
        }
      }
    } catch (err) {
      // RPC blip / rate limit shouldn't block fresh registration — the
      // existing nonce probe + accountExists guard still avoids hard
      // collisions, so log and fall through.
      log.warn(
        { err, companyId },
        "chain-sync pre-check failed; continuing with fresh registration",
      );
    }

    // Pick an unused nonce — start from DB max+1 and probe on-chain to
    // skip any collisions left behind by partial failures.
    let nonce = await nextChainNonce(authority.toBase58());
    let companyPda: PublicKey | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const derived = deriveCompanyPda(authority, nonce);
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
      authority,
      payer: authority,
      nonce,
      metadataUri,
    });

    let signature: string;
    try {
      signature = await sendAndConfirmInstruction({
        instruction,
        payer: operator,
      });
    } catch (err) {
      log.error({ err, companyId, nonce }, "create_company failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistCompanyChainRegistration({
      companyId,
      companyPda: companyPda.toBase58(),
      controllingAuthority: authority.toBase58(),
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
      controllingAuthority: authority.toBase58(),
      chainNonce: nonce,
      chainTxSignature: signature,
    });
  },
);

/**
 * POST /api/chain/agents/:agentId/register
 *
 * Register an agent on-chain (register_agent). Body carries the
 * FE-derived `agentAddress` plus the wallet signature over the canonical
 * derivation message — server verifies the signature against the user's
 * own walletAddress before submitting on-chain.
 *
 * Custody model is pinned to `sign_to_derive` (MVP). Operator hot wallet
 * signs as `controlling_authority` (matches whoever created the company).
 */
router.post(
  "/agents/:agentId/register",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const userWallet = req.user!.walletAddress;
    const agentId = req.params.agentId;

    const parsed = registerAgentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { agentAddress, derivationSignature } = parsed.data;
    const derivationMessageVersion =
      parsed.data.derivationMessageVersion ?? CURRENT_DERIVATION_MSG_VERSION;

    const agent = await findOwnedAgentByUserId({ userId, agentId });
    if (!agent) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    if (agent.agentPda) {
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        agentPda: agent.agentPda,
        agentAddress: agent.agentAddress,
        agentIndex: agent.agentIndex,
        agentChainTxSignature: agent.agentChainTxSignature,
      });
      return;
    }

    // Company must already be on-chain — register company first.
    const companyRow = await findCompanyById(agent.companyId);
    if (!companyRow || !companyRow.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    // Validate agentAddress is a valid pubkey before signature work.
    let agentPubkey: PublicKey;
    try {
      agentPubkey = new PublicKey(agentAddress);
    } catch {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }

    // ── Chain-DB sync pre-check ────────────────────────────────────────
    // If the user's wallet already has an AgentAccount on-chain under
    // this exact company, reuse it instead of creating a new one. Same
    // motivation as the company-side pre-check: keep DB derivable from
    // chain after a wipe.
    //
    // Guard: the on-chain agent_address MUST equal the FE-derived
    // `agentAddress` we received in this request. Custody is
    // `sign_to_derive` and the derivation is deterministic over (wallet,
    // companyPda, agentIndex), so if the FE re-derived correctly the
    // pubkeys match. A mismatch means either the FE used a different
    // derivation (corrupt sig) or the wallet registered an agent under
    // this company via another flow (e.g. a different OCCA instance
    // sharing the same operator) — in either case fail closed and let
    // the caller surface the error rather than silently rebinding to
    // someone else's agent_address.
    try {
      const userWalletPk = new PublicKey(userWallet);
      const onChainAgent = await findAgentByWallet(userWalletPk);
      if (
        onChainAgent &&
        onChainAgent.company.toBase58() === companyRow.companyPda
      ) {
        if (!onChainAgent.agentAddress.equals(agentPubkey)) {
          log.warn(
            {
              agentId,
              wallet: userWallet,
              chainAgentAddress: onChainAgent.agentAddress.toBase58(),
              clientAgentAddress: agentPubkey.toBase58(),
            },
            "on-chain agent_address mismatches client-derived address; refusing reuse",
          );
        } else {
          await persistAgentChainRegistration({
            agentId,
            agentPda: onChainAgent.agentPda.toBase58(),
            agentAddress: onChainAgent.agentAddress.toBase58(),
            agentIndex: onChainAgent.agentIndex,
            custodyModel: CUSTODY_MODEL.SignToDerive,
            derivationMsgVersion: derivationMessageVersion,
            agentChainTxSignature: "",
          });
          log.info(
            {
              agentId,
              agentPda: onChainAgent.agentPda.toBase58(),
              wallet: userWallet,
              agentIndex: onChainAgent.agentIndex,
            },
            "agent already registered on-chain; backfilled DB from chain",
          );
          res.status(StatusCodes.OK).json({
            alreadyRegistered: true,
            recoveredFromChain: true,
            agentPda: onChainAgent.agentPda.toBase58(),
            agentAddress: onChainAgent.agentAddress.toBase58(),
            agentIndex: onChainAgent.agentIndex,
            derivationMessageVersion,
            agentChainTxSignature: null,
          });
          return;
        }
      }
    } catch (err) {
      log.warn(
        { err, agentId },
        "chain-sync pre-check failed; continuing with fresh registration",
      );
    }

    // Pick agent_index, probing on-chain for collisions.
    const companyPda = new PublicKey(companyRow.companyPda);
    let agentIndex = await nextAgentIndex(agent.companyId);
    let agentPda: PublicKey | null = null;
    {
      const { buildRegisterAgentInstruction: _b } = await import("occa-sdk");
      void _b;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const probe = buildRegisterAgentInstruction({
        companyPda,
        controllingAuthority: getOperatorKeypair().publicKey,
        payer: getOperatorKeypair().publicKey,
        agentIndex,
        agentAddress: agentPubkey,
        custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
        roleId: 0,
        adapterId: PublicKey.default,
      });
      // eslint-disable-next-line no-await-in-loop
      const exists = await accountExists(probe.agentPda);
      if (!exists) {
        agentPda = probe.agentPda;
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

    // Verify the user's wallet signed the canonical derivation message
    // for THIS (companyPda, agentIndex). This binds `agentAddress` to the
    // user's wallet — preventing them from registering a random pubkey.
    const message = buildAgentDerivationMessage({
      companyPda: companyPda.toBase58(),
      agentIndex,
      version: derivationMessageVersion,
    });
    const sigOk = await verifySolanaSignature(
      userWallet,
      derivationSignature,
      message,
    );
    if (!sigOk) {
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.SIGNATURE_INVALID });
      return;
    }

    const operator = operatorOrFail(res);
    if (!operator) return;

    const { instruction } = buildRegisterAgentInstruction({
      companyPda,
      controllingAuthority: operator.publicKey,
      payer: operator.publicKey,
      agentIndex,
      agentAddress: agentPubkey,
      custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
      roleId: 0,
      adapterId: PublicKey.default,
    });

    let signature: string;
    try {
      signature = await sendAndConfirmInstruction({
        instruction,
        payer: operator,
      });
    } catch (err) {
      log.error({ err, agentId, agentIndex }, "register_agent failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
      return;
    }

    await persistAgentChainRegistration({
      agentId,
      agentPda: agentPda.toBase58(),
      agentAddress: agentPubkey.toBase58(),
      agentIndex,
      custodyModel: CUSTODY_MODEL.SignToDerive,
      derivationMsgVersion: derivationMessageVersion,
      agentChainTxSignature: signature,
    });

    log.info(
      { agentId, agentPda: agentPda.toBase58(), agentIndex, signature },
      "agent registered on-chain",
    );

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      agentPda: agentPda.toBase58(),
      agentAddress: agentPubkey.toBase58(),
      agentIndex,
      derivationMessageVersion,
      agentChainTxSignature: signature,
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/agents/batch-prepare
 *
 * First half of the hybrid batch hire flow. Allocates an `agent_index`
 * per hire (probing chain for collisions) and persists it onto the agent
 * row. The FE then signs ONE batch derivation message embedding all the
 * indexes, derives N keypairs, and finally calls `batch-register`.
 *
 * Body: `{ agentIds: string[] }`
 *
 * Response:
 *   {
 *     companyPda,
 *     derivationMessageVersion,
 *     hires: [{ agentId, agentIndex }],
 *     // exact message the FE must sign (matches what server will verify)
 *     batchMessage,
 *   }
 *
 * Idempotency: if an agent already has `agent_index` set (from a prior
 * prepare), reuses it. Already-registered agents (have `agent_pda`)
 * are returned with `alreadyRegistered: true` and skipped from
 * allocation/signing.
 */
router.post(
  "/companies/:companyId/agents/batch-prepare",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const companyId = req.params.companyId;

    const parsed = batchPrepareAgentsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { agentIds } = parsed.data;

    const company = await findOwnedCompanyById({ userId, companyId });
    if (!company || !company.companyPda) {
      res
        .status(StatusCodes.PRECONDITION_FAILED)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const companyPda = new PublicKey(company.companyPda);

    const operator = operatorOrFail(res);
    if (!operator) return;

    type Slot = {
      agentId: string;
      agentIndex: number | null;
      alreadyRegistered: boolean;
    };
    const out: Slot[] = [];

    let cursor = await nextAgentIndex(companyId);

    for (const agentId of agentIds) {
      const row = await findOwnedAgentByUserId({ userId, agentId });
      if (!row || row.companyId !== companyId) {
        res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
        return;
      }
      if (row.agentPda) {
        out.push({
          agentId,
          agentIndex: row.agentIndex,
          alreadyRegistered: true,
        });
        continue;
      }
      if (row.agentIndex !== null && row.agentIndex !== undefined) {
        // Reuse existing reservation. Verify still free on chain — if
        // not, surface the conflict so caller can handle.
        out.push({
          agentId,
          agentIndex: row.agentIndex,
          alreadyRegistered: false,
        });
        continue;
      }

      // Allocate fresh — walk cursor probing for free PDA. Since FE
      // doesn't have the derived agent_address yet, we probe by index
      // existence only (PDA depends on companyPda + index, not on
      // agent_address — agent_address is stored in account data).
      let assignedIndex: number | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidatePda = await (async () => {
          // PDA depends ONLY on (companyPda, agentIndex). Use the
          // probe builder with a placeholder agentAddress.
          const probe = buildRegisterAgentInstruction({
            companyPda,
            controllingAuthority: operator.publicKey,
            payer: operator.publicKey,
            agentIndex: cursor,
            agentAddress: PublicKey.default,
            custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
            roleId: 0,
            adapterId: PublicKey.default,
          });
          return probe.agentPda;
        })();
        // eslint-disable-next-line no-await-in-loop
        const exists = await accountExists(candidatePda);
        if (!exists) {
          assignedIndex = cursor;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (assignedIndex === null) {
        log.error(
          { companyId, agentId },
          "batch-prepare: could not allocate free agent_index",
        );
        res
          .status(StatusCodes.CONFLICT)
          .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
        return;
      }

      try {
        await reserveAgentIndex({ agentId, agentIndex: assignedIndex });
      } catch (err) {
        log.error(
          { err, companyId, agentId, assignedIndex },
          "batch-prepare: reserveAgentIndex failed",
        );
        res
          .status(StatusCodes.CONFLICT)
          .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
        return;
      }

      out.push({
        agentId,
        agentIndex: assignedIndex,
        alreadyRegistered: false,
      });
    }

    const newAssignments = out.filter(
      (s) => !s.alreadyRegistered && s.agentIndex !== null,
    );
    const batchMessage = buildBatchDerivationMessage({
      companyPda: companyPda.toBase58(),
      agentIndexes: newAssignments.map((s) => s.agentIndex!),
      version: CURRENT_DERIVATION_MSG_VERSION,
    });

    res.status(StatusCodes.OK).json({
      companyPda: companyPda.toBase58(),
      derivationMessageVersion: CURRENT_DERIVATION_MSG_VERSION,
      hires: out,
      batchMessage,
    });
  },
);

/**
 * POST /api/chain/companies/:companyId/agents/batch-register
 *
 * Hybrid batch hire flow (kickoff). Anchors N agents on-chain with:
 *   • exactly ONE wallet popup (signed over the batch derivation msg),
 *   • ONE (or chunked) Solana transaction, paid by the operator,
 *   • atomic per-tx persistence (each tx confirms before its rows update).
 *
 * Body:
 *   {
 *     derivationSignature: base58/hex 64-byte ed25519 sig,
 *     derivationMessageVersion?: number,
 *     hires: [{ agentId, agentAddress }, ...] // FE-derived per-index
 *   }
 *
 * Server picks each `agent_index` (probing chain for collisions) and
 * the canonical batch message embeds the sorted index list — so the
 * FE must already know its indexes when it builds the message. The FE
 * obtains them via the kickoff response (server pre-assigns at insert
 * time) or via `GET /api/companies/:id/agents` after kickoff.
 */
router.post(
  "/companies/:companyId/agents/batch-register",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const userWallet = req.user!.walletAddress;
    const companyId = req.params.companyId;

    const parsed = batchRegisterAgentsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_BODY });
      return;
    }
    const { derivationSignature, hires } = parsed.data;
    const derivationMessageVersion =
      parsed.data.derivationMessageVersion ?? CURRENT_DERIVATION_MSG_VERSION;

    // Caller must own the company.
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
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const companyPda = new PublicKey(company.companyPda);

    // Resolve every hire row + validate ownership/state in parallel.
    type Prepared = {
      agentId: string;
      agentPubkey: PublicKey;
      // Fields populated below.
      agentIndex?: number;
      agentPda?: PublicKey;
      skip?: "already-registered";
      existingPda?: string | null;
      preReservedIndex?: number | null;
    };
    const prepared: Prepared[] = [];
    for (const h of hires) {
      const row = await findOwnedAgentByUserId({ userId, agentId: h.agentId });
      if (!row || row.companyId !== companyId) {
        res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
        return;
      }
      let agentPubkey: PublicKey;
      try {
        agentPubkey = new PublicKey(h.agentAddress);
      } catch {
        res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: ERROR_CODES.INVALID_BODY });
        return;
      }
      if (row.agentPda) {
        prepared.push({
          agentId: h.agentId,
          agentPubkey,
          skip: "already-registered",
          existingPda: row.agentPda,
        });
        continue;
      }
      prepared.push({
        agentId: h.agentId,
        agentPubkey,
        preReservedIndex: row.agentIndex,
      });
    }

    // Allocate agent_index for every NEW hire. If `batch-prepare` was
    // already called, the row's `agent_index` is non-null and we trust
    // it — the FE has signed a message embedding exactly these indexes,
    // so server cannot deviate. We still verify the corresponding PDA
    // is free (in case of out-of-band drift since prepare).
    //
    // If no pre-reservation, walk forward from the company's max,
    // probing chain for each candidate PDA.
    const operator = operatorOrFail(res);
    if (!operator) return;

    let cursor = await nextAgentIndex(companyId);
    for (const p of prepared) {
      if (p.skip) continue;

      if (p.preReservedIndex !== null && p.preReservedIndex !== undefined) {
        // Trust the pre-reserved index, but verify chain is still free.
        const probe = buildRegisterAgentInstruction({
          companyPda,
          controllingAuthority: operator.publicKey,
          payer: operator.publicKey,
          agentIndex: p.preReservedIndex,
          agentAddress: p.agentPubkey,
          custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
          roleId: 0,
          adapterId: PublicKey.default,
        });
        const exists = await accountExists(probe.agentPda);
        if (exists) {
          log.error(
            {
              companyId,
              agentId: p.agentId,
              preReservedIndex: p.preReservedIndex,
            },
            "batch-register: pre-reserved index now occupied on chain",
          );
          res
            .status(StatusCodes.CONFLICT)
            .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
          return;
        }
        p.agentIndex = p.preReservedIndex;
        p.agentPda = probe.agentPda;
        continue;
      }

      // No pre-reservation — allocate now (fallback path).
      let assigned: { idx: number; pda: PublicKey } | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const probe = buildRegisterAgentInstruction({
          companyPda,
          controllingAuthority: operator.publicKey,
          payer: operator.publicKey,
          agentIndex: cursor,
          agentAddress: p.agentPubkey,
          custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
          roleId: 0,
          adapterId: PublicKey.default,
        });
        // eslint-disable-next-line no-await-in-loop
        const exists = await accountExists(probe.agentPda);
        if (!exists) {
          assigned = { idx: cursor, pda: probe.agentPda };
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!assigned) {
        log.error(
          { companyId, agentId: p.agentId },
          "batch-register: could not allocate free agent_index",
        );
        res
          .status(StatusCodes.CONFLICT)
          .json({ error: ERROR_CODES.CHAIN_TX_FAILED });
        return;
      }
      p.agentIndex = assigned.idx;
      p.agentPda = assigned.pda;
    }

    const newHires = prepared.filter((p) => !p.skip);
    if (newHires.length === 0) {
      // Everything already registered — return current state, no chain ops.
      res.status(StatusCodes.OK).json({
        alreadyRegistered: true,
        registered: prepared.map((p) => ({
          agentId: p.agentId,
          agentPda: p.existingPda,
          alreadyRegistered: true,
        })),
      });
      return;
    }

    // Verify single wallet signature over the canonical batch message
    // (sorted indexes ensure server + client agree byte-for-byte).
    const batchMessage = buildBatchDerivationMessage({
      companyPda: companyPda.toBase58(),
      agentIndexes: newHires.map((p) => p.agentIndex!),
      version: derivationMessageVersion,
    });
    const sigOk = await verifySolanaSignature(
      userWallet,
      derivationSignature,
      batchMessage,
    );
    if (!sigOk) {
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.SIGNATURE_INVALID });
      return;
    }

    // Build all register_agent instructions, then chunk into transactions
    // small enough to fit Solana's 1232-byte limit. Empirically each ix
    // adds ~32 bytes (new agent_pda key) + ~90 bytes (data); 6 ix per tx
    // is safe with overhead.
    const CHUNK_SIZE = 6;
    type Built = Prepared & {
      instruction: ReturnType<
        typeof buildRegisterAgentInstruction
      >["instruction"];
    };
    const built: Built[] = newHires.map((p) => {
      const { instruction } = buildRegisterAgentInstruction({
        companyPda,
        controllingAuthority: operator.publicKey,
        payer: operator.publicKey,
        agentIndex: p.agentIndex!,
        agentAddress: p.agentPubkey,
        custodyModel: custodyModelStringToU8(CUSTODY_MODEL.SignToDerive),
        roleId: 0,
        adapterId: PublicKey.default,
      });
      return { ...p, instruction };
    });

    const registered: Array<{
      agentId: string;
      agentPda: string;
      agentAddress: string;
      agentIndex: number;
      agentChainTxSignature: string;
      alreadyRegistered: false;
    }> = [];

    for (let i = 0; i < built.length; i += CHUNK_SIZE) {
      const chunk = built.slice(i, i + CHUNK_SIZE);
      let signature: string;
      try {
        // eslint-disable-next-line no-await-in-loop
        signature = await sendAndConfirmInstructions({
          instructions: chunk.map((c) => c.instruction),
          payer: operator,
        });
      } catch (err) {
        log.error(
          {
            err,
            companyId,
            chunkSize: chunk.length,
            chunkIndexes: chunk.map((c) => c.agentIndex),
          },
          "batch register_agent tx failed",
        );
        res.status(StatusCodes.BAD_GATEWAY).json({
          error: ERROR_CODES.CHAIN_TX_FAILED,
          // Surface partial progress so FE can resume the unfinished tail.
          partialRegistered: registered,
        });
        return;
      }
      // Persist chunk results sequentially after confirmation.
      for (const c of chunk) {
        // eslint-disable-next-line no-await-in-loop
        await persistAgentChainRegistration({
          agentId: c.agentId,
          agentPda: c.agentPda!.toBase58(),
          agentAddress: c.agentPubkey.toBase58(),
          agentIndex: c.agentIndex!,
          custodyModel: CUSTODY_MODEL.SignToDerive,
          derivationMsgVersion: derivationMessageVersion,
          agentChainTxSignature: signature,
        });
        registered.push({
          agentId: c.agentId,
          agentPda: c.agentPda!.toBase58(),
          agentAddress: c.agentPubkey.toBase58(),
          agentIndex: c.agentIndex!,
          agentChainTxSignature: signature,
          alreadyRegistered: false,
        });
      }
      log.info(
        {
          companyId,
          chunkSize: chunk.length,
          signature,
          indexes: chunk.map((c) => c.agentIndex),
        },
        "batch register_agent chunk confirmed",
      );
    }

    res.status(StatusCodes.OK).json({
      alreadyRegistered: false,
      derivationMessageVersion,
      registered: [
        ...registered,
        ...prepared
          .filter((p) => p.skip === "already-registered")
          .map((p) => ({
            agentId: p.agentId,
            agentPda: p.existingPda,
            alreadyRegistered: true as const,
          })),
      ],
    });
  },
);

export default router;
