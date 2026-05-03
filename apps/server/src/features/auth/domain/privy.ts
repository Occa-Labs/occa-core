// Pure logic for translating a verified Privy user into OCCA's wallet-based
// identity. No SDK calls, no DB — just the rules for picking which Solana
// address counts as canonical for a given Privy user.

import type { User as PrivyUser } from "@privy-io/server-auth";

// OCCA identifies users by their Solana wallet address (whitepaper §4.2.2).
// A Privy user may have many linked accounts; we pick the first verified
// Solana wallet. If none, the user can't onboard until they link one.
export function pickCanonicalSolanaAddress(
  user: PrivyUser,
): string | null {
  const linked = user.linkedAccounts ?? [];
  for (const acct of linked) {
    if (acct.type === "wallet" && acct.chainType === "solana") {
      return acct.address;
    }
  }
  return null;
}

export class PrivyAuthError extends Error {
  constructor(
    public readonly code:
      | "privy_token_invalid"
      | "privy_no_solana_wallet"
      | "privy_not_configured",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PrivyAuthError";
  }
}
