import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../../infra/database/client";
import { authNonces } from "@occa/shared/schema";

export type AuthNonceRow = typeof authNonces.$inferSelect;

export async function insertNonce(args: {
  walletAddress: string;
  nonce: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(authNonces).values(args);
}

export async function findActiveNonce(args: {
  walletAddress: string;
  nonce: string;
  now: Date;
}): Promise<AuthNonceRow | undefined> {
  const [row] = await db
    .select()
    .from(authNonces)
    .where(
      and(
        eq(authNonces.nonce, args.nonce),
        eq(authNonces.walletAddress, args.walletAddress),
        isNull(authNonces.usedAt),
        gt(authNonces.expiresAt, args.now),
      ),
    )
    .limit(1);
  return row;
}

// Atomic claim. Returns true if this caller won the race; false if another
// verify already marked it used.
export async function markNonceUsed(nonceId: string): Promise<boolean> {
  const marked = await db
    .update(authNonces)
    .set({ usedAt: new Date() })
    .where(and(eq(authNonces.id, nonceId), isNull(authNonces.usedAt)))
    .returning({ id: authNonces.id });
  return marked.length > 0;
}
