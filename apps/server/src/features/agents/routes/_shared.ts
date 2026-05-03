// Shared helpers for the `routes/agents/*` sub-routers. Stays inside
// `routes/agents/` because every helper either touches an Express
// `Response` directly or maps an OpenClaw-specific error code — neither
// is allowed in `domain/`. Underscore prefix keeps it visually distinct
// from the resource files (chat.ts, tokens.ts, …) when listing the dir.

import type { Response } from "express";
import { StatusCodes } from "http-status-codes";
import { ERROR_CODES } from "@occa/shared/error-codes";
import {
  deprovisionAgent,
  type ProvisionAgentErrorCode,
  type SeedWorkspaceErrorCode,
  type ValidateKeypairErrorCode,
} from "@occa/adapter-openclaw";
import { eq } from "drizzle-orm";
import { agents, companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";

export const log = childLogger("routes:agents");

export function respondValidateError(
  res: Response,
  code: ValidateKeypairErrorCode,
  reason?: string,
): void {
  switch (code) {
    case "gateway_unauthorized":
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.GATEWAY_UNAUTHORIZED, reason });
      return;
    case "device_pairing_required":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.DEVICE_PAIRING_REQUIRED, reason });
      return;
    case "gateway_unreachable":
    case "gateway_handshake_timeout":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.GATEWAY_UNREACHABLE, reason });
      return;
    default:
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.GATEWAY_PROVISION_FAILED, reason });
  }
}

export function respondProvisionError(
  res: Response,
  code: ProvisionAgentErrorCode,
  reason?: string,
): void {
  switch (code) {
    case "gateway_unauthorized":
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.GATEWAY_UNAUTHORIZED, reason });
      return;
    case "device_pairing_required":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.DEVICE_PAIRING_REQUIRED, reason });
      return;
    case "gateway_unreachable":
    case "gateway_handshake_timeout":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.GATEWAY_UNREACHABLE, reason });
      return;
    case "agent_id_conflict":
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.OPENCLAW_AGENT_ID_CONFLICT, reason });
      return;
    default:
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.GATEWAY_PROVISION_FAILED, reason });
  }
}

export function respondSeedError(
  res: Response,
  code: SeedWorkspaceErrorCode,
  reason?: string,
): void {
  switch (code) {
    case "gateway_unauthorized":
      res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ error: ERROR_CODES.GATEWAY_UNAUTHORIZED, reason });
      return;
    case "device_pairing_required":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.DEVICE_PAIRING_REQUIRED, reason });
      return;
    case "gateway_unreachable":
    case "gateway_handshake_timeout":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.GATEWAY_UNREACHABLE, reason });
      return;
    case "workspace_files_rpc_unavailable":
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.WORKSPACE_FILES_RPC_UNAVAILABLE, reason });
      return;
    default:
      res
        .status(StatusCodes.BAD_GATEWAY)
        .json({ error: ERROR_CODES.WORKSPACE_SEED_FAILED, reason });
  }
}

// Roll back a partially-constructed agent+company after provisioning or
// workspace seeding fails mid-request. Deprovision remotely first (so
// the OpenClaw agents.list stays in sync), then delete the DB rows.
// Cascade handles downstream tables (agent_workspace_files,
// agent_api_keys, etc.) via the FKs set on the schema.
export async function rollbackCreate(args: {
  agentId: string;
  companyRow: typeof companies.$inferSelect | null;
  externalAgentId: string;
  gatewayUrl: string;
  apiKey: string;
  deviceKeypair: Parameters<typeof deprovisionAgent>[0]["device"];
}): Promise<void> {
  try {
    const result = await deprovisionAgent({
      gatewayUrl: args.gatewayUrl,
      apiKey: args.apiKey,
      device: args.deviceKeypair,
      externalAgentId: args.externalAgentId,
    });
    if (!result.ok) {
      log.warn(
        {
          externalAgentId: args.externalAgentId,
          reason: result.reason ?? result.error,
        },
        "rollback deprovision failed",
      );
    }
  } catch (err) {
    log.warn(
      { err, externalAgentId: args.externalAgentId },
      "rollback deprovision threw",
    );
  }
  await db.delete(agents).where(eq(agents.id, args.agentId));
  if (args.companyRow) {
    await db.delete(companies).where(eq(companies.id, args.companyRow.id));
  }
}
