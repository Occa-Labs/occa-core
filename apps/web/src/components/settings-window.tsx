"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  DollarSign,
  LogOut,
  PlayCircle,
  Wallet,
  Webhook,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ROOM_TOUR_WAYPOINTS } from "@/features/theater/constants";
import { AppWindow } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card, CardDivider } from "@/components/ui/card";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { useCompany } from "@/features/companies/api/use-company";
import { WebhooksSection } from "@/features/webhooks/components/webhooks-section";
import { ApiError, devApi } from "@/lib/api";
import { IS_DEV_MODE } from "@/lib/env-flags";

interface SettingsWindowProps {
  /** Active company — webhooks + budget are scoped to it. */
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

type SectionId = "account" | "webhooks" | "budget" | "office" | "devtools";

interface SectionMeta {
  id: SectionId;
  label: string;
  hint: string;
  icon: LucideIcon;
}

const ALL_SECTIONS: SectionMeta[] = [
  { id: "account", label: "Account", hint: "Wallet and session", icon: Wallet },
  { id: "webhooks", label: "Webhooks", hint: "Outbound feeds", icon: Webhook },
  { id: "budget", label: "Budget", hint: "Spend ceiling", icon: DollarSign },
  { id: "office", label: "Office", hint: "Room tour", icon: PlayCircle },
  {
    id: "devtools",
    label: "Dev tools",
    hint: "Debug helpers",
    icon: AlertTriangle,
  },
];

export function SettingsWindow({
  companyId,
  onClose,
  onStartTour,
  tourActive = false,
}: SettingsWindowProps) {
  const { user, signOut } = useAuth();
  const isDev = IS_DEV_MODE;

  // Only surface sections that have a home in the current context.
  const sections = useMemo(
    () =>
      ALL_SECTIONS.filter((s) => {
        if (s.id === "webhooks" || s.id === "budget") return Boolean(companyId);
        if (s.id === "office" || s.id === "devtools") return isDev;
        return true;
      }),
    [companyId, isDev],
  );

  const [active, setActive] = useState<SectionId>("account");
  const activeSection = sections.some((s) => s.id === active)
    ? active
    : "account";

  return (
    <AppWindow
      title="Settings"
      subtitle={user ? "Account & developer tools" : "Not signed in"}
      onClose={onClose}
      defaultSize={{
        w: Math.min(720, Math.round(window.innerWidth * 0.6)),
        h: Math.min(560, Math.round(window.innerHeight * 0.78)),
      }}
      minWidth={560}
      minHeight={360}
    >
      <div className="flex h-full overflow-hidden">
        <Sidebar
          sections={sections}
          active={activeSection}
          onSelect={setActive}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {activeSection === "account" && (
              <AccountSection
                walletAddress={user?.walletAddress ?? "—"}
                userId={user?.id ?? "—"}
                onSignOut={() => signOut()}
              />
            )}

            {activeSection === "webhooks" && companyId && (
              <Pane
                title="Webhooks"
                desc="Outbound connections this company can fire."
              >
                <WebhooksSection companyId={companyId} embedded />
              </Pane>
            )}

            {activeSection === "budget" && companyId && (
              <BudgetSection companyId={companyId} />
            )}

            {activeSection === "office" && isDev && (
              <OfficeSection
                onStartTour={onStartTour}
                tourActive={tourActive}
              />
            )}

            {activeSection === "devtools" && isDev && <DevToolsSection />}
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({
  sections,
  active,
  onSelect,
}: {
  sections: SectionMeta[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <aside
      className="shrink-0 border-r border-white/5 overflow-y-auto"
      style={{ width: 200, background: "rgba(15,15,18,0.6)" }}
    >
      <div className="px-2 py-3">
        {sections.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer ${
                isActive
                  ? "bg-white/10 text-white/90"
                  : "text-white/55 hover:bg-white/5 hover:text-white/80"
              }`}
            >
              <Icon className="size-3.5 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium leading-snug">
                  {s.label}
                </div>
                <div
                  className={`text-[10px] mt-0.5 leading-snug ${
                    isActive ? "text-white/45" : "text-white/30"
                  }`}
                >
                  {s.hint}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ── Pane header (mirrors Company / Chain windows) ─────────────────────────────

function Pane({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-white/90">{title}</h2>
        {desc && <p className="mt-0.5 text-[11px] text-white/45">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Account ───────────────────────────────────────────────────────────────────

function AccountSection({
  walletAddress,
  userId,
  onSignOut,
}: {
  walletAddress: string;
  userId: string;
  onSignOut: () => void;
}) {
  const [copied, setCopied] = useState(false);

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

  return (
    <Pane title="Account" desc="Wallet and session.">
      <Card variant="recessed" padding="none">
        <Row label="Wallet">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-[12px] text-white/80 truncate">
              {walletAddress}
            </span>
            <button
              onClick={() => void onCopy()}
              disabled={walletAddress === "—"}
              className="shrink-0 p-1 rounded-md text-white/40 hover:text-white/80 hover:bg-white/6 transition disabled:opacity-30 cursor-pointer"
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
            {userId}
          </span>
        </Row>

        <CardDivider />

        <Row label="Session">
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut className="size-3" />
            Sign out
          </Button>
        </Row>
      </Card>

      <p className="mt-2.5 text-[11px] text-white/35 leading-relaxed px-1">
        Signing out clears your local session token. The wallet stays
        connected — sign in again to continue.
      </p>
    </Pane>
  );
}

// ── Budget ────────────────────────────────────────────────────────────────────

const budgetInputCls =
  "w-24 rounded-lg bg-white/5 border border-white/10 pl-5 pr-2 py-1 text-[12px] text-white text-right tabular-nums placeholder:text-white/30 focus:outline-none focus:border-white/25 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

function BudgetSection({ companyId }: { companyId: string }) {
  const { company, stats, loading, error, update } = useCompany(companyId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const cents = company?.monthlyBudgetCents ?? null;
  const spentCents = stats?.budgetSpentCents ?? 0;
  const paused = Boolean(company?.pausedAt);
  const display = cents != null ? `$${(cents / 100).toFixed(2)}` : "—";
  const spentDisplay = `$${(spentCents / 100).toFixed(2)}`;
  const exhausted = cents != null && spentCents >= cents;

  const startEdit = () => {
    setDraft(cents != null ? (cents / 100).toFixed(2) : "");
    setSaveError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setSaveError(null);
  };

  const save = async () => {
    const dollars = Number(draft);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setSaveError("Enter an amount greater than 0.");
      return;
    }
    const nextCents = Math.round(dollars * 100);
    setSaving(true);
    setSaveError(null);
    try {
      await update({ monthlyBudgetCents: nextCents });
      setEditing(false);
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? `Couldn't save (api_${err.status}).` : "Couldn't save. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Pane title="Budget" desc="Monthly token budget for all agent activity.">
      {error && (
        <Alert variant="error" className="mb-3">
          Couldn&apos;t load budget.
        </Alert>
      )}

      <Card variant="recessed" padding="none">
        <Row label="Monthly budget">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-white/40">
                  $
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save();
                    if (e.key === "Escape") cancel();
                  }}
                  className={budgetInputCls}
                  placeholder="1.50"
                />
              </div>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-white/85 tabular-nums">
                {loading && cents == null ? "…" : display}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={startEdit}
                disabled={paused || cents == null}
                title={
                  paused ? "Company is paused — resume to edit" : undefined
                }
              >
                Edit
              </Button>
            </div>
          )}
        </Row>

        <CardDivider />

        <Row label="Used this month">
          <span
            className={`text-[13px] tabular-nums ${
              exhausted ? "text-amber-300" : "text-white/85"
            }`}
          >
            {spentDisplay}
            {cents != null && (
              <span className="text-white/35"> / {display}</span>
            )}
          </span>
        </Row>
      </Card>

      {saveError && (
        <Alert variant="error" className="mt-3">
          {saveError}
        </Alert>
      )}

      {exhausted && !saveError && (
        <Alert variant="warning" className="mt-3">
          Budget reached. New tasks and chat are paused until next month —
          raise the budget above to resume now.
        </Alert>
      )}

      <p className="mt-2.5 text-[11px] text-white/35 leading-relaxed px-1">
        One monthly pool for everything that spends tokens — task runs and
        chat. When it&apos;s reached, new work pauses until the next calendar
        month. Runs already underway are never cut off. Operator-domain —
        agents can&apos;t raise their own budget.
      </p>
    </Pane>
  );
}

// ── Office (dev) ──────────────────────────────────────────────────────────────

function OfficeSection({
  onStartTour,
  tourActive,
}: {
  onStartTour?: () => void;
  tourActive: boolean;
}) {
  return (
    <Pane title="Office" desc="Cinematics for the 3D office (dev only).">
      <Card variant="recessed" padding="none">
        <Row label="Room tour">
          <Button
            variant="ghost"
            size="sm"
            disabled={
              !onStartTour || tourActive || ROOM_TOUR_WAYPOINTS.length === 0
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
        Jia walks a guided path through the office, then returns to her spawn
        and disappears.
      </p>
    </Pane>
  );
}

// ── Dev tools (dev) ───────────────────────────────────────────────────────────

function DevToolsSection() {
  const [seedApproval, setSeedApproval] = useState<SeedApprovalState>({
    kind: "idle",
  });

  const runSeedApproval = async () => {
    setSeedApproval({ kind: "running" });
    try {
      const res = await devApi.seedApproval();
      setSeedApproval({ kind: "done", approvalId: res.approvalId });
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
    <Pane title="Dev tools" desc="Local debug helpers (dev only).">
      <Card variant="recessed" padding="none">
        <div className="px-4 py-4 flex items-start gap-3">
          <Bell className="size-4 text-amber-300/60 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <p className="text-[13px] font-medium text-white/80">
                Seed test approval
              </p>
              <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
                Inserts a fake pending approval against your first agent so the
                notification bell (top-right) lights up. Useful while the
                autonomy loop that creates real approvals isn&apos;t shipped
                yet.
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
                {seedApproval.kind === "running" ? "Seeding…" : "Seed approval"}
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
    </Pane>
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
