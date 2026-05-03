// Privy server SDK client — verifies access tokens issued by the Privy
// frontend SDK and resolves them to the underlying user (with linked
// Solana wallet address).
//
// App ID + secret come from `console.privy.io`. Both are required at
// runtime; the app boots without them but verifyPrivyAuth() will throw
// until they're set.

import { PrivyClient } from "@privy-io/server-auth";
import { env } from "../../config/env";

let client: PrivyClient | null = null;

export function getPrivyClient(): PrivyClient {
  if (client) return client;
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error(
      "privy_not_configured: set PRIVY_APP_ID and PRIVY_APP_SECRET in .env",
    );
  }
  client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  return client;
}
