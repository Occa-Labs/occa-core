// Chain-first recovery for `/api/me`.
//
// When a wallet's DB cache is empty (new device, DB wipe, or on-chain
// onboarding via direct SDK), reconstruct the cached company + identity
// + deployment rows from on-chain state. Tier 3 (adapter config,
// externalAgentId, workstation) regenerates with placeholders — the
// FE then prompts the user to re-pair their gateway.
//
// Per CLAUDE.md "Chain = truth, DB = cache":
//   1. Read PDAs by owner wallet → reconstruct Tier 1
//   2. (Tier 2 metadata fetch deferred — only the URI/hash mirror is
//      restored; resolving the JSON is a follow-up worker concern)
//   3. Initialize Tier 3 to placeholders → user re-pairs adapter
//
// Idempotent: every insert uses `onConflictDoNothing`. Safe to call
// repeatedly even if a partial recovery interleaved with a manual write.

import { eq } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import {
  agentIdentities,
  agentRuntimeProfile,
  companies,
  deployments,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import {
  fetchAgentIdentity,
  fetchCompanyForRecovery,
  findCompaniesForWallet,
  listDeploymentsByCompany,
} from "./chain-lookup";

const log = childLogger("chain:recovery");

// Default adapter for Tier 3 placeholder rows. Phase-1 only ships
// `openclaw`; multi-adapter Phase-2 will extend this once `adapter_id`
// → adapter-type resolution is wired (Derived tier per CLAUDE.md).
const DEFAULT_ADAPTER_TYPE = "openclaw";

// On-chain `status` byte → DB `status` text. Mirrors the encoding in
// `agent_runtime_profile`/`deployments.status` columns.
function chainStatusToText(byte: number): string {
  if (byte === 1) return "paused";
  if (byte === 2) return "retired";
  return "active";
}

export interface RecoveryResult {
  recovered: boolean;
  companyId?: string;
  deploymentCount?: number;
}

export async function recoverFromChainIfMissing(args: {
  userId: string;
  walletAddress: string;
}): Promise<RecoveryResult> {
  let walletPk: PublicKey;
  try {
    walletPk = new PublicKey(args.walletAddress);
  } catch {
    return { recovered: false };
  }

  const chainCompanies = await findCompaniesForWallet(walletPk);
  if (chainCompanies.length === 0) {
    return { recovered: false };
  }

  // MVP: one wallet = one user = one company. If chain has multiple,
  // pick the lowest nonce — first one the user created.
  const target = chainCompanies.sort((a, b) => a.nonce - b.nonce)[0];

  const companyFull = await fetchCompanyForRecovery(target.companyPda);
  if (!companyFull) {
    log.warn(
      { pda: target.companyPda.toBase58() },
      "recover: company PDA exists but full decode failed; aborting",
    );
    return { recovered: false };
  }

  const chainDeployments = await listDeploymentsByCompany(target.companyPda);
  const identityCache = new Map<
    string,
    Awaited<ReturnType<typeof fetchAgentIdentity>>
  >();
  for (const d of chainDeployments) {
    const key = d.agentIdentity.toBase58();
    if (!identityCache.has(key)) {
      identityCache.set(key, await fetchAgentIdentity(d.agentIdentity));
    }
  }

  const result = await db.transaction(async (tx) => {
    const [companyRow] = await tx
      .insert(companies)
      .values({
        ownerUserId: args.userId,
        name: companyFull.name,
        kind: "user",
        companyPda: companyFull.companyPda.toBase58(),
        ownerWallet: companyFull.owner.toBase58(),
        chainNonce: companyFull.nonce,
        locale: companyFull.locale || null,
        metadataUri: companyFull.metadataUri || null,
        metadataHash: companyFull.metadataHash.toString("hex"),
        chainStatus: chainStatusToText(companyFull.status),
      })
      .onConflictDoNothing({ target: companies.companyPda })
      .returning({ id: companies.id });

    if (!companyRow) {
      // Already recovered concurrently — locate the existing row by PDA
      // so the rest of the recovery can attach to it.
      const [existing] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.companyPda, companyFull.companyPda.toBase58()))
        .limit(1);
      if (!existing) {
        throw new Error("company recovered but lookup failed");
      }
      return { companyId: existing.id, deploymentCount: 0 };
    }

    const identityIdByPda = new Map<string, string>();
    for (const [pdaB58, identity] of identityCache.entries()) {
      if (!identity) continue;
      const [iRow] = await tx
        .insert(agentIdentities)
        .values({
          ownerUserId: args.userId,
          agentPubkey: identity.agentPubkey.toBase58(),
          identityPda: identity.identityPda.toBase58(),
          ownerWallet: identity.owner.toBase58(),
          name: identity.name,
          metadataUri: identity.metadataUri || null,
          metadataHash: identity.metadataHash.toString("hex"),
        })
        .onConflictDoNothing({ target: agentIdentities.identityPda })
        .returning({ id: agentIdentities.id });
      if (iRow) {
        identityIdByPda.set(pdaB58, iRow.id);
      } else {
        const [existing] = await tx
          .select({ id: agentIdentities.id })
          .from(agentIdentities)
          .where(eq(agentIdentities.identityPda, identity.identityPda.toBase58()))
          .limit(1);
        if (existing) identityIdByPda.set(pdaB58, existing.id);
      }
    }

    let deploymentCount = 0;
    for (const d of chainDeployments) {
      const identityId = identityIdByPda.get(d.agentIdentity.toBase58());
      if (!identityId) {
        log.warn(
          {
            deploymentPda: d.deploymentPda.toBase58(),
            identityPda: d.agentIdentity.toBase58(),
          },
          "recover: skipping deployment — identity not recovered",
        );
        continue;
      }
      const operatingWalletStr = d.operatingWallet.equals(PublicKey.default)
        ? null
        : d.operatingWallet.toBase58();
      const adapterIdStr = d.adapterId.equals(PublicKey.default)
        ? null
        : d.adapterId.toBase58();
      const [dRow] = await tx
        .insert(deployments)
        .values({
          companyId: companyRow.id,
          agentIdentityId: identityId,
          deploymentPda: d.deploymentPda.toBase58(),
          deploymentIndex: d.deploymentIndex,
          role: d.role,
          parentDeploymentIndex: d.parentDeploymentIndex,
          adapterId: adapterIdStr,
          operatingWallet: operatingWalletStr,
          status: chainStatusToText(d.status),
          metadataUri: d.metadataUri || null,
          metadataHash: d.metadataHash.toString("hex"),
        })
        .onConflictDoNothing({ target: deployments.deploymentPda })
        .returning({ id: deployments.id });
      if (!dRow) continue;

      // Tier 3 placeholder — adapterConfig is empty so the FE detects
      // the re-pair-needed state via `externalAgentId == null`. The
      // re-pair dialog calls reprovision which fills in real creds.
      await tx.insert(agentRuntimeProfile).values({
        deploymentId: dRow.id,
        companyId: companyRow.id,
        adapterType: DEFAULT_ADAPTER_TYPE,
        adapterConfig: { gatewayUrl: "", apiKey: "" },
        provisioningState: "pending",
      });
      deploymentCount += 1;
    }

    return { companyId: companyRow.id, deploymentCount };
  });

  log.info(
    {
      userId: args.userId,
      wallet: args.walletAddress,
      companyId: result.companyId,
      deploymentCount: result.deploymentCount,
    },
    "chain recovery completed",
  );

  return {
    recovered: true,
    companyId: result.companyId,
    deploymentCount: result.deploymentCount,
  };
}
