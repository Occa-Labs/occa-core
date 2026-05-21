/**
 * Feature flags — single source of truth for which UI surfaces are
 * exposed in which environments.
 *
 * Why a module instead of inline `process.env` checks:
 * - Centralizes the production-vs-dev gating logic so shell, settings,
 *   feature components, etc. all agree on what "production mode" means.
 * - Lets local dev preview the production chrome by flipping a single
 *   env var (`NEXT_PUBLIC_PREVIEW_PRODUCTION=1` in `.env.local`) without
 *   editing any component.
 * - Keeps the env-var keys in one place — easier to audit + rename.
 *
 * Conventions:
 * - All flags are *consumer-side*: read at render time. `NEXT_PUBLIC_*`
 *   vars get inlined by Next at build time, so toggling them locally
 *   requires restarting `next dev`.
 * - Default each flag to its production-safe value. Flipping to `true`
 *   should always *reveal* a feature, never hide one. (Makes "did I
 *   forget to set the env var?" a recoverable mistake.)
 */

// True when the app should render the production chrome — i.e. trim
// work-in-progress windows from the dock, hide unfinished CTAs, etc.
//
// Triggered by:
//   - real production builds (`NODE_ENV === "production"`), OR
//   - local opt-in via `NEXT_PUBLIC_PREVIEW_PRODUCTION=1` in
//     `apps/web/.env.local` so we can QA the trimmed UI without
//     redeploying.
export const IS_PRODUCTION_MODE: boolean =
  process.env.NODE_ENV === "production" ||
  process.env.NEXT_PUBLIC_PREVIEW_PRODUCTION === "1";

// True when the hosted production instance is opened for use — skips the
// "Production not ready" gate (see shell/production-gate.tsx) and boots
// the full OS. Off by default so a fresh deploy stays gated; the operator
// opts in by setting `NEXT_PUBLIC_UNLOCK_PRODUCTION=1` at build time.
export const UNLOCK_PRODUCTION: boolean =
  process.env.NEXT_PUBLIC_UNLOCK_PRODUCTION === "1";

// True when dev-only affordances (Dev Tools dock item, waypoint
// recorder, floor-grid overlay, debug panels) are allowed to render.
// Stays false in the local production preview so the dev surfaces
// disappear together with the WIP feature surfaces.
export const IS_DEV_MODE: boolean =
  process.env.NODE_ENV === "development" && !IS_PRODUCTION_MODE;

// Per-feature gates. Feature components import the flag directly:
//
//   import { FEATURES } from "@/lib/env-flags";
//   if (!FEATURES.tasks) return null;
//
// When a WIP feature ships, flip its entry to `true` (or delete the
// line — `FEATURES` is non-exhaustive on purpose, only WIP features
// need an entry). Production-only kill-switches can also live here.
export const FEATURES = {
  // Task manager (per-company task board, assign/reassign/close).
  tasks: true,
  // Routines (per-agent scheduled wake-ups / cron). Dev-only, plus the
  // unlocked production instance (operator runs real routines there).
  routines: IS_DEV_MODE || UNLOCK_PRODUCTION,
  // Skill library. Hidden in stock production while the import / publish
  // flow is still in flux; revealed on the unlocked operator instance.
  skills: !IS_PRODUCTION_MODE || UNLOCK_PRODUCTION,
  // Workflow auto-follow-up rules. Always on now that the engine is
  // deterministic (linear-only, no LLM dep) and exercised live.
  workflows: true,
  // Tools primitive (per-company tool installs: X, Notion, MCP, ...).
  // On in dev and on the unlocked operator instance while we land the
  // first handlers.
  tools: IS_DEV_MODE || UNLOCK_PRODUCTION,
} as const;

export type FeatureKey = keyof typeof FEATURES;

// Solana cluster the app is currently pointed at. Read from
// `NEXT_PUBLIC_SOLANA_CLUSTER` (set in `apps/web/.env.local` and at
// build time on Vercel). Defaults to `devnet` so local dev never
// silently claims to be on mainnet.
export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

const RAW_CLUSTER = (
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet"
).toLowerCase();

export const SOLANA_CLUSTER: SolanaCluster =
  RAW_CLUSTER === "mainnet" || RAW_CLUSTER === "mainnet-beta"
    ? "mainnet-beta"
    : RAW_CLUSTER === "testnet"
      ? "testnet"
      : RAW_CLUSTER === "localnet" || RAW_CLUSTER === "localhost"
        ? "localnet"
        : "devnet";

export const IS_MAINNET: boolean = SOLANA_CLUSTER === "mainnet-beta";

// CAIP-2 chain id for the active cluster. Privy's signTransaction /
// signAndSendTransaction expect this format (`solana:mainnet`,
// `solana:devnet`, `solana:testnet`). Localnet has no canonical CAIP id;
// we map it to devnet so wallets don't reject the tx.
export type SolanaCaipChain =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet";

export const SOLANA_CAIP_CHAIN: SolanaCaipChain =
  SOLANA_CLUSTER === "mainnet-beta"
    ? "solana:mainnet"
    : SOLANA_CLUSTER === "testnet"
      ? "solana:testnet"
      : "solana:devnet";

// ── $OCCA token gate ───────────────────────────────────────────────
// After login, the OS is held behind a balance check: only wallets
// holding at least OCCA_GATE_AMOUNT $OCCA may enter (see
// shell/token-gate.tsx).
//
// The $OCCA token lives on Solana *mainnet* (a pump.fun mint),
// independent of NEXT_PUBLIC_SOLANA_CLUSTER — the agent/treasury
// programs run on devnet while the gate always queries mainnet. So the
// gate carries its own mint + RPC config rather than reusing the
// cluster settings above.

// SPL mint of the $OCCA token. Overridable via env in case the mint
// is ever re-deployed; defaults to the live pump.fun mint.
export const OCCA_TOKEN_MINT: string =
  process.env.NEXT_PUBLIC_OCCA_MINT ??
  "GYSHDDoVtFNdzR72SSkmJcKWFVh9ndhMdYoDKdg8pump";

// Minimum $OCCA (UI amount, decimal-adjusted) a wallet must hold to
// pass the gate. Defaults to 1,000,000.
export const OCCA_GATE_AMOUNT: number = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_OCCA_GATE_AMOUNT);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
})();

// Mainnet RPC endpoint the gate queries for the $OCCA balance. The
// public endpoint rate-limits getParsedTokenAccountsByOwner hard —
// point NEXT_PUBLIC_OCCA_GATE_RPC at a dedicated provider
// (Helius / QuickNode) for production.
export const OCCA_GATE_RPC: string =
  process.env.NEXT_PUBLIC_OCCA_GATE_RPC ??
  "https://api.mainnet-beta.solana.com";

// Local opt-out: skip the token gate entirely so contributors without
// $OCCA can still boot the OS. Off by default — never set in prod.
export const BYPASS_TOKEN_GATE: boolean =
  process.env.NEXT_PUBLIC_BYPASS_TOKEN_GATE === "1";

// Per-wallet bypass allowlist — team / founder wallets that should
// always pass the gate regardless of $OCCA balance. Compared
// case-sensitively against the logged-in wallet's base58 address.
export const TOKEN_GATE_ALLOWLIST: readonly string[] = [
  "9Cf2ziACruWvQ5UM1hr3GgAD8wzxnTfbCPLn6zW3D7Yr",
  "9eTsYw4TssCSrY3yCD346Swb5rtdmskQnVt6VPX3u4q7",
];
