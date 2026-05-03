import { eq, sql } from "drizzle-orm";
import { db } from "../../../infra/database/client";
import { users } from "@occa/shared/schema";

export type UserRow = typeof users.$inferSelect;

export async function findUserById(userId: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row;
}

export async function upsertUserByWallet(walletAddress: string): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({ walletAddress })
    .onConflictDoUpdate({
      target: users.walletAddress,
      set: { walletAddress: sql`excluded.wallet_address` },
    })
    .returning();
  return row;
}
