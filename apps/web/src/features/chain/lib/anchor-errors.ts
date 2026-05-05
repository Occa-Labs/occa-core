import { ApiError } from "@/lib/api";

export type AnchorErrorCode =
  | "wallet_not_ready"
  | "wallet_not_connected"
  | "wallet_mismatch"
  | "user_rejected_signature"
  | "wallet_signature_failed"
  | "operator_not_configured"
  | "chain_tx_failed"
  | "company_not_found"
  | "agent_not_found"
  | "signature_invalid"
  | "network_error"
  | "unknown";

const SERVER_ERROR_MAP: Record<string, AnchorErrorCode> = {
  OPERATOR_NOT_CONFIGURED: "operator_not_configured",
  CHAIN_TX_FAILED: "chain_tx_failed",
  COMPANY_NOT_FOUND: "company_not_found",
  AGENT_NOT_FOUND: "agent_not_found",
  SIGNATURE_INVALID: "signature_invalid",
  INVALID_SIGNATURE_VERSION: "signature_invalid",
  WALLET_MISMATCH: "wallet_mismatch",
};

export function mapServerError(err: unknown): {
  code: AnchorErrorCode;
  message: string;
} {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | undefined;
    const serverCode = body?.error;
    if (serverCode && SERVER_ERROR_MAP[serverCode]) {
      return {
        code: SERVER_ERROR_MAP[serverCode],
        message: body?.message ?? serverCode,
      };
    }
    return {
      code: "unknown",
      message: serverCode ?? `api_${err.status}`,
    };
  }
  return {
    code: "network_error",
    message: err instanceof Error ? err.message : "Network error",
  };
}

export function classifyWalletError(err: unknown): {
  code: AnchorErrorCode;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.toLowerCase();
  if (
    msg.includes("reject") ||
    msg.includes("cancel") ||
    msg.includes("declined") ||
    msg.includes("denied")
  ) {
    return { code: "user_rejected_signature", message: raw };
  }
  if (msg.includes("not connected") || msg.includes("no wallet")) {
    return { code: "wallet_not_connected", message: raw };
  }
  return { code: "wallet_signature_failed", message: raw };
}

export function prettifyAnchorError(code: AnchorErrorCode): {
  headline: string;
  hint: string;
} {
  switch (code) {
    case "wallet_not_ready":
      return {
        headline: "Wallet still loading.",
        hint: "Privy is still provisioning your embedded wallet. Wait a moment and retry.",
      };
    case "wallet_not_connected":
      return {
        headline: "Wallet not connected.",
        hint: "Reconnect your Solana wallet (or wait for the embedded wallet to finish provisioning) and retry.",
      };
    case "wallet_mismatch":
      return {
        headline: "Wallet mismatch.",
        hint: "The connected wallet doesn't match your OCCA identity. Reconnect with the original wallet.",
      };
    case "user_rejected_signature":
      return {
        headline: "Wallet signature rejected.",
        hint: "You cancelled the signature. Click Retry and approve the popup.",
      };
    case "wallet_signature_failed":
      return {
        headline: "Wallet signature failed.",
        hint: "Privy couldn't get a signature from your wallet. Retry, and if it persists reconnect the wallet.",
      };
    case "operator_not_configured":
      return {
        headline: "Server isn't ready to sign on-chain.",
        hint: "OCCA_OPERATOR_SECRET_KEY is missing on the server. Set a funded devnet keypair (base58 secretKey) in apps/server/.env, then restart the server.",
      };
    case "chain_tx_failed":
      return {
        headline: "On-chain transaction failed.",
        hint: "Solana transaction didn't confirm. Check operator balance on devnet and retry.",
      };
    case "company_not_found":
    case "agent_not_found":
      return {
        headline: "On-chain target missing.",
        hint: "Server can't find the company or agent record. Refresh the page.",
      };
    case "signature_invalid":
      return {
        headline: "Derivation signature rejected.",
        hint: "Server couldn't verify the signature against the wallet. Retry to sign a fresh message.",
      };
    case "network_error":
      return {
        headline: "Network error.",
        hint: "Couldn't reach the OCCA server — check connectivity and retry.",
      };
    default:
      return {
        headline: "Anchoring failed.",
        hint: code.replace(/_/g, " "),
      };
  }
}
