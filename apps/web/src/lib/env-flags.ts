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
  // Hidden in production until the assignment pipeline lands.
  tasks: !IS_PRODUCTION_MODE,
  // Routines (per-agent scheduled wake-ups / cron). Dev-only for now.
  routines: IS_DEV_MODE,
  // Skill library. Hidden in production while the import / publish flow
  // is still in flux.
  skills: !IS_PRODUCTION_MODE,
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
