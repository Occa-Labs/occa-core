"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  LogOut,
  PlayCircle,
  RotateCcw,
  Server,
  Wallet,
} from "lucide-react";
import { ROOM_TOUR_WAYPOINTS } from "@/features/theater/constants";
import { AppWindow } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card, CardDivider } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { ApiError, devApi } from "@/lib/api";
import { IS_DEV_MODE } from "@/lib/env-flags";

interface SettingsWindowProps {
  onClose?: () => void;
  onReset?: () => Promise<void> | void;
  /** Triggers the "Room Tour" cinematic — Jia walks the recorded path
   *  and returns to her spawn. Disabled when there are no waypoints. */
  onStartTour?: () => void;
  /** True while a tour is currently playing. Disables the button so the
   *  user can't restart mid-walk. */
  tourActive?: boolean;
}

type ResetState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | {
      kind: "done";
      deleted: { companies: number; otherUsers: number; nonces: number };
    }
  | { kind: "error"; message: string };

type GatewayResetState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | {
      kind: "done";
      target: string;
      removed: string[];
      failures: string[];
    }
  | { kind: "error"; message: string };

type SeedApprovalState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; approvalId: string }
  | { kind: "error"; message: string };

export function SettingsWindow({
  onClose,
  onReset,
  onStartTour,
  tourActive = false,
}: SettingsWindowProps) {
  const { user, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [reset, setReset] = useState<ResetState>({ kind: "idle" });
  const [gatewayReset, setGatewayReset] = useState<GatewayResetState>({
    kind: "idle",
  });
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

  const runReset = async () => {
    setReset({ kind: "running" });
    try {
      const res = await devApi.reset();
      setReset({ kind: "done", deleted: res.deleted });
      await onReset?.();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `api_${err.status}`
          : err instanceof Error
            ? err.message
            : "reset_failed";
      setReset({ kind: "error", message });
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

  const runGatewayReset = async () => {
    setGatewayReset({ kind: "running" });
    try {
      const res = await devApi.resetGateway();
      setGatewayReset({
        kind: "done",
        target: res.target,
        removed: res.removed,
        failures: res.failures,
      });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `api_${err.status}` +
            (typeof err.body === "object" && err.body && "error" in err.body
              ? `: ${(err.body as { error: string }).error}`
              : "")
          : err instanceof Error
            ? err.message
            : "gateway_reset_failed";
      setGatewayReset({ kind: "error", message });
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
                <RotateCcw className="size-4 text-amber-300/60 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <p className="text-[13px] font-medium text-white/80">
                      Reset database
                    </p>
                    <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
                      Wipes companies, agents, tasks, traces, routines, and
                      other users (cascade-deletes their downstream rows). Your
                      wallet, user account, and the built-in skill catalog are
                      preserved so you can re-onboard.
                    </p>
                  </div>

                  {reset.kind === "idle" && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setReset({ kind: "confirming" })}
                    >
                      <RotateCcw className="size-3" />
                      Reset database
                    </Button>
                  )}

                  {reset.kind === "confirming" && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void runReset()}
                      >
                        <AlertTriangle className="size-3" />
                        Confirm — wipe everything
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setReset({ kind: "idle" })}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {reset.kind === "running" && (
                    <p className="text-[11px] text-white/45">
                      Wiping database…
                    </p>
                  )}

                  {reset.kind === "done" && (
                    <Alert variant="success">
                      Done. Removed {reset.deleted.companies} compan
                      {reset.deleted.companies === 1 ? "y" : "ies"},{" "}
                      {reset.deleted.otherUsers} other user
                      {reset.deleted.otherUsers === 1 ? "" : "s"}, and{" "}
                      {reset.deleted.nonces} auth nonce
                      {reset.deleted.nonces === 1 ? "" : "s"}.
                    </Alert>
                  )}

                  {reset.kind === "error" && (
                    <Alert variant="error">
                      Reset failed: {reset.message}{" "}
                      <button
                        onClick={() => setReset({ kind: "confirming" })}
                        className="underline hover:text-white/90 transition-colors"
                      >
                        Retry
                      </button>
                    </Alert>
                  )}
                </div>
              </div>

              <CardDivider />

              <div className="px-4 py-4 flex items-start gap-3">
                <Server className="size-4 text-amber-300/60 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <p className="text-[13px] font-medium text-white/80">
                      Reset gateway
                    </p>
                    <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
                      SSH into the OpenClaw gateway VPS and remove every agent
                      whose id starts with{" "}
                      <span className="font-mono">occa-</span>. The{" "}
                      <span className="font-mono">main</span> agent is protected
                      by OpenClaw and cannot be deleted. Removed agents go to
                      the VPS Trash, not hard-deleted.
                    </p>
                  </div>

                  {gatewayReset.kind === "idle" && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setGatewayReset({ kind: "confirming" })}
                    >
                      <Server className="size-3" />
                      Reset gateway
                    </Button>
                  )}

                  {gatewayReset.kind === "confirming" && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void runGatewayReset()}
                      >
                        <AlertTriangle className="size-3" />
                        Confirm — wipe occa-* agents
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setGatewayReset({ kind: "idle" })}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {gatewayReset.kind === "running" && (
                    <p className="text-[11px] text-white/45">
                      Connecting to gateway and deleting agents…
                    </p>
                  )}

                  {gatewayReset.kind === "done" && (
                    <Alert
                      variant={
                        gatewayReset.failures.length === 0 ? "success" : "error"
                      }
                    >
                      <div className="space-y-1">
                        <div>
                          {gatewayReset.removed.length === 0
                            ? "No occa-* agents on gateway."
                            : `Removed ${gatewayReset.removed.length} agent${gatewayReset.removed.length === 1 ? "" : "s"} from ${gatewayReset.target}.`}
                          {gatewayReset.failures.length > 0 &&
                            ` ${gatewayReset.failures.length} failed.`}
                        </div>
                        {gatewayReset.removed.length > 0 && (
                          <div className="font-mono text-[10px] text-white/55">
                            {gatewayReset.removed.join(", ")}
                          </div>
                        )}
                        {gatewayReset.failures.length > 0 && (
                          <div className="font-mono text-[10px] text-rose-300/80">
                            failed: {gatewayReset.failures.join(", ")}
                          </div>
                        )}
                      </div>
                    </Alert>
                  )}

                  {gatewayReset.kind === "error" && (
                    <Alert variant="error">
                      Gateway reset failed: {gatewayReset.message}{" "}
                      <button
                        onClick={() => setGatewayReset({ kind: "confirming" })}
                        className="underline hover:text-white/90 transition-colors"
                      >
                        Retry
                      </button>
                    </Alert>
                  )}
                </div>
              </div>

              <CardDivider />

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
