"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  LogOut,
  PlayCircle,
  Wallet,
} from "lucide-react";
import { ROOM_TOUR_WAYPOINTS } from "@/features/theater/constants";
import { AppWindow } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card, CardDivider } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { WebhooksSection } from "@/features/webhooks/components/webhooks-section";
import { ApiError, devApi } from "@/lib/api";
import { IS_DEV_MODE } from "@/lib/env-flags";

interface SettingsWindowProps {
  /** Active company — webhooks are scoped to it. */
  companyId?: string;
  onClose?: () => void;
  /** Triggers the "Room Tour" cinematic — Jia walks the recorded path
   *  and returns to her spawn. Disabled when there are no waypoints. */
  onStartTour?: () => void;
  /** True while a tour is currently playing. Disables the button so the
   *  user can't restart mid-walk. */
  tourActive?: boolean;
}

type SeedApprovalState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; approvalId: string }
  | { kind: "error"; message: string };

export function SettingsWindow({
  companyId,
  onClose,
  onStartTour,
  tourActive = false,
}: SettingsWindowProps) {
  const { user, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [seedApproval, setSeedApproval] = useState<SeedApprovalState>({
    kind: "idle",
  });

  const walletAddress = user?.walletAddress ?? "—";
  const isDev = IS_DEV_MODE;

  const onCopy = async () => {
    if (walletAddress === "—") return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const runSeedApproval = async () => {
    setSeedApproval({ kind: "running" });
    try {
      const res = await devApi.seedApproval();
      setSeedApproval({ kind: "done", approvalId: res.approvalId });
      // Auto-clear the success badge after a moment so repeat clicks feel snappy.
      setTimeout(() => setSeedApproval({ kind: "idle" }), 2000);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `api_${err.status}` +
            (typeof err.body === "object" && err.body && "error" in err.body
              ? `: ${(err.body as { error: string }).error}`
              : "")
          : err instanceof Error
            ? err.message
            : "seed_failed";
      setSeedApproval({ kind: "error", message });
    }
  };

  return (
    <AppWindow
      title="Settings"
      subtitle={user ? "Account & developer tools" : "Not signed in"}
      onClose={onClose}
      defaultSize={{
        w: Math.min(560, Math.round(window.innerWidth * 0.5)),
        h: Math.min(580, Math.round(window.innerHeight * 0.75)),
      }}
      minWidth={400}
      minHeight={320}
    >
      <div className="flex flex-col gap-7 px-5 py-5">
        {/* ── Account ───────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-1.5 mb-3">
            <Wallet className="size-3 text-white/35" />
            <SectionLabel>Account</SectionLabel>
          </div>

          <Card variant="recessed" padding="none">
            <Row label="Wallet">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[12px] text-white/80 truncate">
                  {walletAddress}
                </span>
                <button
                  onClick={() => void onCopy()}
                  disabled={walletAddress === "—"}
                  className="shrink-0 p-1 rounded-md text-white/40 hover:text-white/80 hover:bg-white/6 transition disabled:opacity-30"
                  title="Copy wallet address"
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>
            </Row>

            <CardDivider />

            <Row label="User ID">
              <span className="font-mono text-[11px] text-white/45 truncate">
                {user?.id ?? "—"}
              </span>
            </Row>

            <CardDivider />

            <Row label="Session">
              <Button variant="ghost" size="sm" onClick={() => signOut()}>
                <LogOut className="size-3" />
                Sign out
              </Button>
            </Row>
          </Card>

          <p className="mt-2.5 text-[11px] text-white/35 leading-relaxed px-1">
            Signing out clears your local session token. The wallet stays
            connected — sign in again to continue.
          </p>
        </section>

        {/* ── Webhooks (per-company outbound connections) ───────────────────── */}
        {companyId && <WebhooksSection companyId={companyId} />}

        {/* ── Office cinematics (dev only) ──────────────────────────────────── */}
        {isDev && (
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <PlayCircle className="size-3 text-white/35" />
              <SectionLabel>Office</SectionLabel>
            </div>

            <Card variant="recessed" padding="none">
              <Row label="Room tour">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    !onStartTour ||
                    tourActive ||
                    ROOM_TOUR_WAYPOINTS.length === 0
                  }
                  onClick={() => onStartTour?.()}
                  title={
                    ROOM_TOUR_WAYPOINTS.length === 0
                      ? "No tour path recorded yet"
                      : tourActive
                        ? "Tour already running"
                        : "Jia will walk you around the office"
                  }
                >
                  <PlayCircle className="size-3" />
                  {tourActive ? "Touring…" : "Start tour"}
                </Button>
              </Row>
            </Card>

            <p className="mt-2.5 text-[11px] text-white/35 leading-relaxed px-1">
              Jia walks a guided path through the office, then returns to her
              spawn and disappears.
            </p>
          </section>
        )}

        {/* ── Dev tools (dev only) ──────────────────────────────────────────── */}
        {isDev && (
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <AlertTriangle className="size-3 text-amber-400/70" />
              <SectionLabel className="text-amber-400/60">
                Dev tools
              </SectionLabel>
            </div>

            <Card variant="recessed" padding="none">
              <div className="px-4 py-4 flex items-start gap-3">
                <Bell className="size-4 text-amber-300/60 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <p className="text-[13px] font-medium text-white/80">
                      Seed test approval
                    </p>
                    <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
                      Inserts a fake pending approval against your first agent
                      so the notification bell (top-right) lights up. Useful
                      while the autonomy loop that creates real approvals isn't
                      shipped yet.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void runSeedApproval()}
                      disabled={seedApproval.kind === "running"}
                    >
                      <Bell className="size-3" />
                      {seedApproval.kind === "running"
                        ? "Seeding…"
                        : "Seed approval"}
                    </Button>
                    {seedApproval.kind === "done" && (
                      <span className="text-[11px] text-emerald-300/80">
                        ✓ created
                      </span>
                    )}
                  </div>

                  {seedApproval.kind === "error" && (
                    <Alert variant="error">
                      Seed failed: {seedApproval.message}
                    </Alert>
                  )}
                </div>
              </div>
            </Card>
          </section>
        )}
      </div>
    </AppWindow>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-[11px] text-white/40 font-medium shrink-0">
        {label}
      </span>
      <div className="flex items-center min-w-0 justify-end">{children}</div>
    </div>
  );
}
