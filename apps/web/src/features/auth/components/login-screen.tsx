"use client";

import { AlertCircle, RefreshCw, Wallet as WalletIcon, X } from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { OccaLogo } from "@/components/icons/occa-logo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// Outermost gate of the OS. Shown whenever the user is not authenticated:
// a full-screen wallpaper (background.jpg) with a centered glass panel
// carrying the brand + a single Connect action. The 3D office, top bar,
// and dock do NOT mount until the user is past this screen — login is the
// first thing rendered, not a button nesting inside the desktop.

// User-readable mapping for raw auth error codes. Mirrors the table in
// wallet-connect-overlay so the login screen surfaces the same language.
function prettifyAuthError(code: string): string {
  switch (code) {
    case "exchange_timeout":
      return "Sign-in timed out. Check your connection and retry.";
    case "privy_no_access_token":
      return "Wallet session expired. Reconnect and try again.";
    case "privy_login_failed":
      return "Wallet connect failed. Try again or reload the page.";
    case "privy_token_invalid":
      return "Privy session is invalid. Reconnect to refresh.";
    case "privy_no_solana_wallet":
      return "No Solana wallet linked to this Privy account.";
    case "privy_not_configured":
      return "Sign-in needs a Privy app id. Set NEXT_PUBLIC_PRIVY_APP_ID in apps/web/.env.local (free from console.privy.io).";
    case "hydrate_failed":
      return "Couldn't reach the server. Retry when it's back up.";
    case "sign_in_failed":
      return "Sign-in failed. Retry or reload the page.";
    default:
      return code;
  }
}

export function LoginScreen() {
  const { status, error, signIn, cancel } = useAuth();

  const inFlight =
    status === "booting" ||
    status === "connecting-privy" ||
    status === "exchanging";

  const inFlightLabel =
    status === "booting"
      ? "Loading…"
      : status === "connecting-privy"
        ? "Connecting…"
        : "Signing in…";

  return (
    <main className="fixed inset-0 h-screen w-screen overflow-hidden">
      {/* Wallpaper */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url(/images/background.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      />
      {/* Readability scrim — keeps the panel legible over any wallpaper */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 40%, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.72) 100%)",
        }}
      />

      <div className="relative z-10 flex h-full w-full items-center justify-center p-6">
        <Card
          spotlight
          padding="lg"
          className="w-full max-w-sm text-center"
        >
          <div className="flex flex-col items-center gap-6 px-2 py-4">
            <OccaLogo width={48} height={48} className="text-white" />

            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                OCCA
              </h1>
              <p className="text-sm text-white/55 leading-relaxed">
                The operating layer for companies run by agents.
              </p>
            </div>

            {/* CTA — one action, reflects the auth state machine */}
            {inFlight ? (
              <div className="flex w-full flex-col items-center gap-2">
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <Spinner variant="block" className="text-sm text-white/70" />
                  {inFlightLabel}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancel}
                  className="text-white/45"
                >
                  <X className="size-3.5" />
                  Cancel
                </Button>
              </div>
            ) : status === "error" ? (
              <div className="flex w-full flex-col items-center gap-3">
                <div className="flex items-start gap-2 text-left text-xs text-red-300/90">
                  <AlertCircle className="size-4 shrink-0" />
                  <span className="leading-relaxed">
                    {error ? prettifyAuthError(error) : "Sign-in failed."}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="lg"
                  block
                  onClick={signIn}
                >
                  <RefreshCw className="size-4" />
                  Retry sign in
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="lg" block onClick={signIn}>
                <WalletIcon className="size-4" />
                Connect wallet
              </Button>
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}
