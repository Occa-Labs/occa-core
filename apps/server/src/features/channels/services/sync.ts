// Channel sync service. v1 ships storage + UI only — the channel
// transport (Telegram polling, Discord gateway, etc.) lives in a
// separate OCCA-side orchestrator service that consumes these rows.
// Adapters stay channel-agnostic: BYORT keeps runtime concerns and
// transport concerns orthogonal (channels work the same regardless of
// which adapter the CEO runs on).
//
// Flow on upsert:
//   1. Validate creds against the channel-specific zod schema.
//   2. Write the row to DB. Status flips to "connected" if enabled, or
//      "off" if disabled. The transport orchestrator updates this later
//      with live state ("connecting" while authenticating with the
//      platform, "error" on auth failure, etc).
//
// CEO-only enforcement lives in the route layer.

import { eq } from "drizzle-orm";
import { deploymentChannels } from "@occa/shared/schema";
import type { ChannelType, ChannelDTO } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import {
  credentialsSchemaFor,
  summarizeCredentials,
} from "../domain/schemas";
import {
  listByDeployment,
  markStatus,
  remove as removeRow,
  upsert,
} from "../repositories/channels";

export type ChannelSyncError =
  | { code: "credentials_invalid"; reason: string }
  | { code: "deployment_not_found" };

export interface ChannelSyncOk {
  ok: true;
  channel: ChannelDTO;
}

export interface ChannelSyncFail {
  ok: false;
  error: ChannelSyncError;
}

export type ChannelSyncResult = ChannelSyncOk | ChannelSyncFail;

export async function listChannels(
  deploymentId: string,
): Promise<ChannelDTO[]> {
  const rows = await listByDeployment(deploymentId);
  return rows.map((r) => toDto(r));
}

export async function upsertChannel(args: {
  deploymentId: string;
  channelType: ChannelType;
  credentials: Record<string, unknown>;
  enabled: boolean;
  chatEnabled: boolean;
  notifEnabled: boolean;
}): Promise<ChannelSyncResult> {
  const credsParse = credentialsSchemaFor(args.channelType).safeParse(
    args.credentials,
  );
  if (!credsParse.success) {
    return {
      ok: false,
      error: {
        code: "credentials_invalid",
        reason: credsParse.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      },
    };
  }

  await upsert({
    deploymentId: args.deploymentId,
    channelType: args.channelType,
    credentials: args.credentials,
    enabled: args.enabled,
    chatEnabled: args.chatEnabled,
    notifEnabled: args.notifEnabled,
  });
  // Optimistic: mark connected if enabled. The transport orchestrator
  // will downgrade to "error" if creds turn out invalid on first poll /
  // webhook attempt.
  await markStatus({
    deploymentId: args.deploymentId,
    channelType: args.channelType,
    status: args.enabled ? "connected" : "off",
    statusMsg: null,
  });

  const updated = await listByDeployment(args.deploymentId);
  const after = updated.find((r) => r.channelType === args.channelType);
  if (!after) {
    return { ok: false, error: { code: "deployment_not_found" } };
  }
  return { ok: true, channel: toDto(after) };
}

export async function deleteChannel(args: {
  deploymentId: string;
  channelType: ChannelType;
}): Promise<ChannelSyncResult> {
  await removeRow(args.deploymentId, args.channelType);
  return {
    ok: true,
    channel: {
      channelType: args.channelType,
      enabled: false,
      chatEnabled: false,
      notifEnabled: false,
      status: "off",
      statusMsg: null,
      lastSyncedAt: null,
      credentialsSummary: {},
      updatedAt: new Date().toISOString(),
    },
  };
}

function toDto(row: typeof deploymentChannels.$inferSelect): ChannelDTO {
  return {
    channelType: row.channelType as ChannelType,
    enabled: row.enabled,
    chatEnabled: row.chatEnabled,
    notifEnabled: row.notifEnabled,
    status: row.status as ChannelDTO["status"],
    statusMsg: row.statusMsg,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    credentialsSummary: summarizeCredentials(
      row.channelType as ChannelType,
      row.credentials,
    ),
    updatedAt: row.updatedAt.toISOString(),
  };
}
