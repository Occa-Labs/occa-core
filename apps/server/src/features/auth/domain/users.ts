// User identity rules. Pure — no DB, no HTTP.

import { users } from "@occa/shared/schema";
import type { AuthUser } from "@occa/shared/types";

export const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function toAuthUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    name: row.name,
    isPlatform: row.isPlatform,
    createdAt: row.createdAt.toISOString(),
  };
}
