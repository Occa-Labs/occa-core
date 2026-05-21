// Agent Wallet — read-only views over the on-chain receiving address.
//
// Mounts under `/api/agents/:id/wallet/*` + `/api/agents/:id/onchain`.
// Pure RPC + chain-decode aggregation; no DB writes. The setter path
// (set_receiving_address ix) is covered by the existing chain routes
// at `/api/chain/agents/:agentId/operating-wallet/{prepare,confirm}`.

import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { deriveAgentIdentityPda } from "occa-sdk";
import { requireAuth } from "../../../middleware/auth";
import { getConnection } from "../../../infra/solana/connection";
import { findOwnedByUserId } from "../repositories/deployments";
import { findById as findIdentityById } from "../repositories/agent-identities";
import {
  fetchDeployment,
  fetchAgentIdentity,
} from "../../chain/services/chain-lookup";
import {
  countPendingInvoices,
  listInvoicesByDeployment,
} from "../../billing/repositories/invoices";
import { reconcileInvoicesForDeployment } from "../../billing/services/reconcile-invoices";
import { log } from "./_shared";

const router: Router = Router();

// Tx history pagination — capped to keep `getSignaturesForAddress` cheap.
// Solana RPC accepts up to 1000; we surface up to 50/page so the UI page
// loads stay snappy.
const MAX_TX_PAGE_LIMIT = 50;
const DEFAULT_TX_PAGE_LIMIT = 20;

const txQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TX_PAGE_LIMIT)
      .optional(),
    before: z.string().min(64).max(96).optional(),
  })
  .strict();

// Sentinel comparator for "address not yet set on-chain" — chain stores
// `Pubkey::default()` (all zeros) as the unset value.
function isUnsetReceivingAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  if (addr === PublicKey.default.toBase58()) return true;
  return false;
}

// ── GET /api/agents/:id/wallet ─────────────────────────────────────────────
//
// Returns the receiving-address basics: address (or null), live SOL balance
// in lamports, and whether the address is set yet. Single RPC call when
// the address is configured; zero RPC calls when unset.
router.get(
  "/:id/wallet",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const deploymentId = req.params.id;

    const dep = await findOwnedByUserId({ userId, deploymentId });
    if (!dep) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    const address = isUnsetReceivingAddress(dep.operatingWallet)
      ? null
      : dep.operatingWallet;

    if (!address) {
      res.status(StatusCodes.OK).json({
        address: null,
        balanceLamports: null,
        hasAddress: false,
      });
      return;
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      // Stored value isn't a valid pubkey — treat as unset rather than 500.
      log.warn({ deploymentId, address }, "wallet: stored address invalid");
      res.status(StatusCodes.OK).json({
        address: null,
        balanceLamports: null,
        hasAddress: false,
      });
      return;
    }

    let balanceLamports: number;
    try {
      balanceLamports = await getConnection().getBalance(pubkey, "confirmed");
    } catch (err) {
      log.error({ err, deploymentId }, "wallet: getBalance failed");
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.UPSTREAM_FAILED });
      return;
    }

    res.status(StatusCodes.OK).json({
      address,
      balanceLamports,
      hasAddress: true,
    });
  },
);

// ── GET /api/agents/:id/wallet/transactions ────────────────────────────────
//
// Cursor-paginated tx history for the receiving address. Cursor is the
// signature string of the last item from the prior page (Solana RPC's
// `before` parameter). Returns empty array when address unset.
router.get(
  "/:id/wallet/transactions",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const deploymentId = req.params.id;

    const parsed = txQuery.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.INVALID_QUERY });
      return;
    }
    const limit = parsed.data.limit ?? DEFAULT_TX_PAGE_LIMIT;
    const before = parsed.data.before;

    const dep = await findOwnedByUserId({ userId, deploymentId });
    if (!dep) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    if (isUnsetReceivingAddress(dep.operatingWallet)) {
      res.status(StatusCodes.OK).json({ transactions: [], nextCursor: null });
      return;
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(dep.operatingWallet!);
    } catch {
      res.status(StatusCodes.OK).json({ transactions: [], nextCursor: null });
      return;
    }

    let signatures: ConfirmedSignatureInfo[];
    try {
      signatures = await getConnection().getSignaturesForAddress(
        pubkey,
        { limit, before },
        "confirmed",
      );
    } catch (err) {
      log.error(
        { err, deploymentId },
        "wallet: getSignaturesForAddress failed",
      );
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.UPSTREAM_FAILED });
      return;
    }

    const transactions = signatures.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      err: s.err === null ? null : "error",
      memo: s.memo ?? null,
    }));

    // If we got back a full page, more might exist — surface the last sig
    // as the cursor for the next call.
    const nextCursor =
      transactions.length === limit
        ? transactions[transactions.length - 1].signature
        : null;

    res.status(StatusCodes.OK).json({ transactions, nextCursor });
  },
);

// ── GET /api/agents/:id/onchain ────────────────────────────────────────────
//
// Authoritative read straight from chain — Deployment + AgentIdentity PDAs.
// Two-account batched RPC (one round-trip). Used by the Wallet tab's
// "On-chain data" section to display chain-of-truth values rather than
// the DB cache, so users can verify what's actually on Solana.
router.get(
  "/:id/onchain",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const deploymentId = req.params.id;

    const dep = await findOwnedByUserId({ userId, deploymentId });
    if (!dep) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // DB has the deployment_pda; identity PDA we re-derive from the
    // identity row's `agent_pubkey`.
    const identity = await findIdentityById(dep.agentIdentityId);
    if (!identity) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    let deploymentPda: PublicKey;
    let identityPda: PublicKey;
    try {
      deploymentPda = new PublicKey(dep.deploymentPda);
      // Identity PDA is derived deterministically from the agent_pubkey,
      // not stored as a base58 column we trust blindly.
      identityPda = deriveAgentIdentityPda(
        new PublicKey(identity.agentPubkey),
      ).pda;
    } catch (err) {
      log.error(
        { err, deploymentId, identityId: identity.id },
        "onchain: invalid stored pubkey",
      );
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }

    const [chainDeployment, chainIdentity] = await Promise.all([
      fetchDeployment(deploymentPda).catch((err) => {
        log.error({ err, deploymentId }, "onchain: fetchDeployment failed");
        return null;
      }),
      fetchAgentIdentity(identityPda).catch((err) => {
        log.error({ err, deploymentId }, "onchain: fetchAgentIdentity failed");
        return null;
      }),
    ]);

    res.status(StatusCodes.OK).json({
      deployment: chainDeployment
        ? {
            deploymentPda: chainDeployment.deploymentPda.toBase58(),
            deploymentIndex: chainDeployment.deploymentIndex,
            agentIdentityPda: chainDeployment.agentIdentity.toBase58(),
            companyPda: chainDeployment.company.toBase58(),
            owner: chainDeployment.owner.toBase58(),
            // chain-lookup.ts still exposes this field as `operatingWallet`
            // (legacy decoder name) — semantically it's the receiving address
            // per registry/lib.rs:740. Renamed at the API boundary here so
            // the FE can use the post-v0.10 vocabulary.
            receivingAddress: isUnsetReceivingAddress(
              chainDeployment.operatingWallet.toBase58(),
            )
              ? null
              : chainDeployment.operatingWallet.toBase58(),
            adapterId: chainDeployment.adapterId.toBase58(),
            role: chainDeployment.role,
            parentDeploymentIndex: chainDeployment.parentDeploymentIndex,
            status: chainDeployment.status,
            metadataUri: chainDeployment.metadataUri,
          }
        : null,
      identity: chainIdentity
        ? {
            identityPda: chainIdentity.identityPda.toBase58(),
            agentPubkey: chainIdentity.agentPubkey.toBase58(),
            owner: chainIdentity.owner.toBase58(),
            name: chainIdentity.name,
            metadataUri: chainIdentity.metadataUri,
          }
        : null,
    });
  },
);

// ── GET /api/agents/:id/invoices ───────────────────────────────────────────
//
// All invoices billed for this agent's completed tasks, newest first, plus
// a pending count for the Wallet tab stat. Off-chain billing records —
// pure DB read, no RPC.
router.get(
  "/:id/invoices",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const deploymentId = req.params.id;

    const dep = await findOwnedByUserId({ userId, deploymentId });
    if (!dep) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.AGENT_NOT_FOUND });
      return;
    }

    // Self-heal on read: back-fill any `done` task that the live hook
    // missed (runtime bug, un-hooked path, or task completed before the
    // rate was set) before listing. Idempotent + cheap.
    try {
      await reconcileInvoicesForDeployment(deploymentId);
    } catch (err) {
      // Non-fatal — surface the (possibly stale) list anyway.
      log.error({ err, deploymentId }, "invoice reconcile on read failed");
    }

    const rows = await listInvoicesByDeployment(deploymentId);
    const pendingCount = await countPendingInvoices(deploymentId);

    res.status(StatusCodes.OK).json({
      invoices: rows.map((r) => ({
        id: r.id,
        amountLamports: r.amountLamports,
        status: r.status,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        taskNumber: r.taskNumber,
        txSignature: r.txSignature,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        paidAt: r.paidAt ? r.paidAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      pendingCount,
    });
  },
);

export default router;
