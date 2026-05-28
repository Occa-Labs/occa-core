// Deployment channels repo — one row per (deployment, channel_type).
// CEO-only by design but enforcement lives in the route layer so this
// repo stays pure CRUD.

import { and, asc, eq } from "drizzle-orm";
import { deploymentChannels } from "@occa/shared/schema";
import type { ChannelType } from "@occa/shared/types";
import { db } from "../../../infra/database/client";

export type DeploymentChannelRow = typeof deploymentChannels.$inferSelect;

export async function listByDeployment(
  deploymentId: string,
): Promise<DeploymentChannelRow[]> {
  return db
    .select()
    .from(deploymentChannels)
    .where(eq(deploymentChannels.deploymentId, deploymentId))
    .orderBy(asc(deploymentChannels.channelType));
}

export async function findOne(
  deploymentId: string,
  channelType: ChannelType,
): Promise<DeploymentChannelRow | null> {
  const [row] = await db
    .select()
    .from(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, deploymentId),
        eq(deploymentChannels.channelType, channelType),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface UpsertInput {
  deploymentId: string;
  channelType: ChannelType;
  credentials: Record<string, unknown>;
  enabled: boolean;
  chatEnabled: boolean;
  notifEnabled: boolean;
}

export async function upsert(input: UpsertInput): Promise<DeploymentChannelRow> {
  const now = new Date();
  const [row] = await db
    .insert(deploymentChannels)
    .values({
      deploymentId: input.deploymentId,
      channelType: input.channelType,
      credentials: input.credentials,
      enabled: input.enabled,
      chatEnabled: input.chatEnabled,
      notifEnabled: input.notifEnabled,
      status: "off",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [deploymentChannels.deploymentId, deploymentChannels.channelType],
      set: {
        credentials: input.credentials,
        enabled: input.enabled,
        chatEnabled: input.chatEnabled,
        notifEnabled: input.notifEnabled,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function markStatus(args: {
  deploymentId: string;
  channelType: ChannelType;
  status: "off" | "connecting" | "connected" | "error";
  statusMsg?: string | null;
}): Promise<void> {
  await db
    .update(deploymentChannels)
    .set({
      status: args.status,
      statusMsg: args.statusMsg ?? null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentChannels.deploymentId, args.deploymentId),
        eq(deploymentChannels.channelType, args.channelType),
      ),
    );
}

export async function remove(
  deploymentId: string,
  channelType: ChannelType,
): Promise<void> {
  await db
    .delete(deploymentChannels)
    .where(
      and(
        eq(deploymentChannels.deploymentId, deploymentId),
        eq(deploymentChannels.channelType, channelType),
      ),
    );
}
