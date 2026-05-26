"use client";

import { useEffect, useState } from "react";
import {
  Anchor,
  ArrowLeft,
  ArrowRight,
  Check,
  Coins,
  Copy,
  ExternalLink,
  List,
  Loader2,
  RefreshCw,
  Stamp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  CLUSTER_LABEL,
  explorerAddressUrl,
  explorerTxUrl,
  shortenAddress,
  solscanAddressUrl,
  solscanTxUrl,
} from "@/lib/solana-explorer";
import { formatRoleLabel } from "@/lib/format-role";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import type { AgentDTO, CompanyDTO } from "@occa/shared/types";
import { TreasuryPane } from "./treasury-pane";
import { WalletTab } from "./wallet-tab";
import { AnchorSetupModal } from "./anchor-setup-modal";
import { useCompanyAnchors } from "../api/use-company-anchors";
import { useCompanyTransactions } from "../api/use-company-transactions";
import type {
  CompanyTransactionRecord,
  DailyAnchorRecord,
} from "@/lib/api";

type SectionId =
  | "registry"
  | "treasury"
  | "anchors"
  | "transactions"
  | "agents";

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  icon: LucideIcon;
  hint: string;
  comingSoon?: boolean;
}> = [
  {
    id: "registry",
    label: "Registry",
    icon: Anchor,
    hint: "Company PDA, owner, anchor tx",
  },
  {
    id: "treasury",
    label: "Treasury",
    icon: Coins,
    hint: "Balance, budget, operations, payouts",
  },
  {
    id: "anchors",
    label: "Anchors",
    icon: Stamp,
    hint: "Daily Merkle commits",
  },
  {
    id: "transactions",
    label: "Transactions",
    icon: List,
    hint: "All on-chain activity",
  },
  {
    id: "agents",
    label: "Agents",
    icon: Users,
    hint: "Per-agent identity + wallet",
  },
];

interface ChainWindowProps {
  company: CompanyDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
  onClose?: () => void;
  /** Pre-select a section on mount. Updates after mount also reroute,
   *  so a fresh notification click switches the active tab even if the
   *  window is already open. */
  initialSection?: SectionId;
}

export function ChainWindow({
  company,
  agents,
  onReloadMe,
  onClose,
  initialSection,
}: ChainWindowProps) {
  const [active, setActive] = useState<SectionId>(
    initialSection ?? "registry",
  );
  // Subsequent prop changes (deep-link re-fire) retarget the active tab.
  useEffect(() => {
    if (initialSection) setActive(initialSection);
  }, [initialSection]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    agents[0]?.id ?? null,
  );

  // Auto-select first agent the first time the user lands on the Agents
  // section. Also recovers when the previously selected agent disappears
  // (retired / removed from the company).
  useEffect(() => {
    if (active !== "agents") return;
    if (selectedAgentId && agents.some((a) => a.id === selectedAgentId))
      return;
    setSelectedAgentId(agents[0]?.id ?? null);
  }, [active, selectedAgentId, agents]);

  const selectedAgent =
    agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;

  const handleSelectAgent = (id: string) => {
    setSelectedAgentId(id);
    setActive("agents");
  };

  return (
    <AppWindow
      title="Chain"
      subtitle={`${company.name} · ${CLUSTER_LABEL}`}
      onClose={onClose}
      defaultSize={{
        w: Math.min(960, Math.round(window.innerWidth * 0.75)),
        h: Math.min(680, Math.round(window.innerHeight * 0.82)),
      }}
      minWidth={720}
      minHeight={460}
    >
      <div className="flex h-full overflow-hidden">
        <Sidebar
          active={active}
          onSelect={setActive}
          agents={agents}
          selectedAgentId={selectedAgent?.id ?? null}
          onSelectAgent={handleSelectAgent}
        />
        <div className="flex-1 flex flex-col min-w-0">
          {active === "agents" ? (
            <AgentsSection agent={selectedAgent} onReloadMe={onReloadMe} />
          ) : (
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {active === "registry" && (
                <RegistrySection
                  company={company}
                  agents={agents}
                  onReloadMe={onReloadMe}
                />
              )}
              {active === "treasury" && (
                <TreasurySection company={company} />
              )}
              {active === "anchors" && (
                <AnchorsSection companyId={company.id} />
              )}
              {active === "transactions" && (
                <TransactionsSection companyId={company.id} />
              )}
            </div>
          )}
        </div>
      </div>
    </AppWindow>
  );
}

function Sidebar({
  active,
  onSelect,
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  agents: AgentDTO[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  return (
    <aside
      className="shrink-0 border-r border-white/5 overflow-y-auto"
      style={{ width: 220, background: "rgba(15,15,18,0.6)" }}
    >
      <div className="px-2 py-3 flex flex-col gap-0.5">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <div key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className={`
                  w-full flex items-start gap-2 px-2.5 py-2 rounded-lg
                  text-left transition-all cursor-pointer
                  ${
                    isActive
                      ? "bg-white/10 text-white/90"
                      : "text-white/55 hover:bg-white/5 hover:text-white/80"
                  }
                `}
              >
                <Icon className="size-3.5 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium leading-snug flex items-center gap-1.5">
                    {s.label}
                    {s.comingSoon && (
                      <span className="text-[9px] uppercase tracking-wide text-white/35 font-normal">
                        soon
                      </span>
                    )}
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

              {s.id === "agents" && agents.length > 0 && (
                <div className="mt-0.5 ml-3 pl-2 border-l border-white/8 flex flex-col gap-0.5">
                  {agents.map((a) => {
                    const isSel =
                      active === "agents" && a.id === selectedAgentId;
                    const isAnchored = a.agentChainTxSignature !== null;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => onSelectAgent(a.id)}
                        className={`
                          flex items-center gap-2 px-2 py-1.5 rounded-md
                          text-left transition-colors cursor-pointer
                          ${
                            isSel
                              ? "bg-white/8 text-white/90"
                              : "text-white/50 hover:bg-white/4 hover:text-white/80"
                          }
                        `}
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            isAnchored ? "bg-emerald-400" : "bg-white/25"
                          }`}
                          title={
                            isAnchored ? "Anchored on chain" : "Not anchored"
                          }
                        />
                        <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium">
                          {a.name}
                        </span>
                        <span
                          className={`text-[9.5px] truncate max-w-20 text-right ${
                            isSel ? "text-white/45" : "text-white/30"
                          }`}
                        >
                          {formatRoleLabel(a.role)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-white/90">{title}</h2>
      {desc && <p className="mt-0.5 text-[11px] text-white/45">{desc}</p>}
    </div>
  );
}

function SetupCard({
  companyAnchored,
  onOpen,
}: {
  companyAnchored: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-4 flex items-center gap-3">
      <div className="size-9 shrink-0 rounded-full bg-amber-400/20 flex items-center justify-center">
        <Anchor className="size-4 text-amber-200" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-amber-100">
          {companyAnchored
            ? "Anchor setup incomplete"
            : "Set up on Solana"}
        </p>
        <p className="mt-0.5 text-[11px] text-amber-100/65 leading-relaxed">
          {companyAnchored
            ? "Company is anchored. Finish CEO identity + deployment to unlock the wallet and payout flows."
            : "Three signatures register the company, your CEO's identity, and the CEO deployment on-chain. Each step is explained before you sign."}
        </p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-amber-400/90 hover:bg-amber-300 text-black px-3 py-1.5 text-[12px] font-semibold transition-colors cursor-pointer"
      >
        <Anchor className="size-3" />
        {companyAnchored ? "Resume setup" : "Start setup"}
      </button>
    </div>
  );
}

function TreasurySection({ company }: { company: CompanyDTO }) {
  return (
    <div>
      <SectionHeader
        title="Treasury"
        desc="Company SOL balance, monthly disbursement budget, Operating Fee, and operations setup."
      />
      <TreasuryPane company={company} />
    </div>
  );
}

function AnchorsSection({ companyId }: { companyId: string }) {
  const anchors = useCompanyAnchors(companyId);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white/90">Anchors</h2>
          <p className="mt-0.5 text-[11px] text-white/45">
            Daily Merkle commits of agent task streams. Read-only — chain is
            the source of truth.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void anchors.refetch()}
          disabled={anchors.isFetching}
          className="shrink-0 p-1.5 rounded-lg text-white/45 hover:bg-white/8 hover:text-white/80 transition-colors disabled:opacity-40 cursor-pointer"
          title="Refresh"
        >
          {anchors.isFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>

      {anchors.isLoading && !anchors.data && (
        <Card variant="recessed" padding="md">
          <div className="flex items-center gap-2 text-[12px] text-white/45">
            <Loader2 className="size-3.5 animate-spin" />
            Reading anchors from chain…
          </div>
        </Card>
      )}

      {anchors.error && (
        <Alert variant="error">
          Couldn&apos;t read anchors from chain. Try refreshing.
        </Alert>
      )}

      {anchors.data && anchors.data.anchors.length === 0 && (
        <Card variant="recessed" padding="md">
          <p className="text-[12px] text-white/55 leading-relaxed">
            No daily anchors yet. The Anchor Wallet commits one per agent per
            UTC day with task activity. New commits appear here within a few
            hours of midnight UTC.
          </p>
        </Card>
      )}

      {anchors.data && anchors.data.anchors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {anchors.data.anchors.map((a) => (
            <AnchorRow key={a.pda} anchor={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnchorRow({ anchor }: { anchor: DailyAnchorRecord }) {
  const dayLabel = formatUtcDay(anchor.dayUnix);
  const committedRel = formatRelative(anchor.committedAt);

  return (
    <Card variant="recessed" padding="sm">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-medium text-white/90">
              {dayLabel}
            </span>
            <span className="text-[10px] text-white/35">
              committed {committedRel}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-white/55 truncate">
            {anchor.agentName ?? "(unknown agent)"}
            {anchor.agentRole && (
              <span className="text-white/35">
                {" · "}
                {formatRoleLabel(anchor.agentRole)}
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[12px] font-medium text-white/85 tabular-nums">
            {anchor.taskCount}
            <span className="text-[10px] text-white/40 ml-1 font-normal">
              {anchor.taskCount === 1 ? "task" : "tasks"}
            </span>
          </div>
          <div className="mt-0.5 inline-flex items-center gap-1">
            <code
              className="text-[10px] font-mono text-white/45"
              title={`Merkle root ${anchor.merkleRoot}`}
            >
              {anchor.merkleRoot.slice(0, 8)}…{anchor.merkleRoot.slice(-6)}
            </code>
            <MerkleCopy hex={anchor.merkleRoot} />
            <a
              href={solscanAddressUrl(anchor.pda)}
              target="_blank"
              rel="noreferrer noopener"
              className="p-0.5 rounded text-white/40 hover:bg-white/8 hover:text-white/75 transition-colors"
              title="View PDA on Solscan"
            >
              <ExternalLink className="size-2.5" />
            </a>
          </div>
        </div>
      </div>
    </Card>
  );
}

function MerkleCopy({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
    } catch {
      // Clipboard blocked — silent.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className="p-0.5 rounded text-white/40 hover:bg-white/8 hover:text-white/75 transition-colors cursor-pointer"
      title={copied ? "Copied" : "Copy Merkle root"}
      aria-label={copied ? "Copied" : "Copy Merkle root"}
    >
      {copied ? (
        <Check className="size-2.5 text-emerald-300" />
      ) : (
        <Copy className="size-2.5" />
      )}
    </button>
  );
}

function formatUtcDay(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  // UTC label — anchors are aligned to 00:00:00 UTC so showing the local
  // date would mislead readers near midnight UTC.
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRelative(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TransactionsSection({ companyId }: { companyId: string }) {
  // Pagination state: stack of `before` cursors. Top = signature of the
  // last item on the previous page. Pop on Back, push the last sig of
  // current page on Next.
  const [pageStack, setPageStack] = useState<string[]>([]);
  const beforeCursor = pageStack[pageStack.length - 1] ?? null;
  const txs = useCompanyTransactions(companyId, {
    limit: 25,
    before: beforeCursor,
  });

  const handleNext = () => {
    if (!txs.data || txs.data.records.length === 0) return;
    const lastSig = txs.data.records[txs.data.records.length - 1].signature;
    setPageStack((prev) => [...prev, lastSig]);
  };
  const handlePrev = () => {
    setPageStack((prev) => prev.slice(0, -1));
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white/90">Transactions</h2>
          <p className="mt-0.5 text-[11px] text-white/45">
            Every on-chain transaction touching this company&apos;s PDAs:
            company account, treasury, policy, operations, agent
            deployments, daily anchors. Latest first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void txs.refetch()}
          disabled={txs.isFetching}
          className="shrink-0 p-1.5 rounded-lg text-white/45 hover:bg-white/8 hover:text-white/80 transition-colors disabled:opacity-40 cursor-pointer"
          title="Refresh"
        >
          {txs.isFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>

      {txs.isLoading && !txs.data && (
        <Card variant="recessed" padding="md">
          <div className="flex items-center gap-2 text-[12px] text-white/45">
            <Loader2 className="size-3.5 animate-spin" />
            Reading transactions from chain…
          </div>
        </Card>
      )}

      {txs.error && (
        <Alert variant="error">
          Couldn&apos;t read transactions from chain. Try refreshing.
        </Alert>
      )}

      {txs.data && txs.data.records.length === 0 && (
        <Card variant="recessed" padding="md">
          <p className="text-[12px] text-white/55 leading-relaxed">
            No on-chain activity yet. Transactions appear here as you
            register, fund, anchor, and pay out.
          </p>
        </Card>
      )}

      {txs.data && txs.data.records.length > 0 && (
        <>
          <div className="rounded-xl border border-white/8 overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_1.6fr_auto] gap-3 px-3 py-2 bg-white/3 text-[10px] uppercase tracking-wider text-white/40">
              <span>Time</span>
              <span>Action</span>
              <span>Signer</span>
              <span>Tx</span>
            </div>
            <div className="divide-y divide-white/6">
              {txs.data.records.map((r) => (
                <TransactionRow key={r.signature} record={r} />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-white/45">
            <span>
              Page {pageStack.length + 1}
              {txs.data.hasMore || pageStack.length > 0
                ? ` · ${txs.data.records.length} on this page`
                : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrev}
                disabled={pageStack.length === 0 || txs.isFetching}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-white/55 hover:bg-white/8 hover:text-white/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <ArrowLeft className="size-3" />
                Prev
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={!txs.data.hasMore || txs.isFetching}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-white/55 hover:bg-white/8 hover:text-white/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                Next
                <ArrowRight className="size-3" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TransactionRow({ record }: { record: CompanyTransactionRecord }) {
  const reverted = record.err !== null;
  const time = record.blockTime
    ? formatRelative(record.blockTime)
    : `slot ${record.slot}`;
  return (
    <div className="grid grid-cols-[1fr_2fr_1.6fr_auto] gap-3 px-3 py-2 items-center text-[11.5px]">
      <span className="text-white/65 truncate" title={
        record.blockTime
          ? new Date(record.blockTime * 1000).toLocaleString()
          : undefined
      }>
        {time}
      </span>
      <span
        className={`truncate ${
          reverted ? "text-rose-300/90" : "text-white/85"
        }`}
      >
        {record.action ?? <span className="text-white/35 italic">unknown</span>}
        {reverted && (
          <span className="ml-1.5 text-[10px] font-medium text-rose-300/80">
            (reverted)
          </span>
        )}
      </span>
      <span
        className="font-mono text-[10.5px] text-white/55 truncate"
        title={record.signer ?? undefined}
      >
        {record.signer ? shortenAddress(record.signer, 4, 4) : "—"}
      </span>
      <a
        href={solscanTxUrl(record.signature)}
        target="_blank"
        rel="noopener noreferrer"
        className={`shrink-0 inline-flex items-center gap-1 font-mono text-[10.5px] transition-colors ${
          reverted
            ? "text-rose-300/85 hover:text-rose-200"
            : "text-white/55 hover:text-white/85"
        }`}
        title="Open in Solscan"
      >
        {shortenAddress(record.signature, 4, 4)}
        <ExternalLink className="size-2.5" />
      </a>
    </div>
  );
}

function AgentsSection({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO | null;
  onReloadMe: () => Promise<void> | void;
}) {
  if (!agent) {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <SectionHeader
          title="Agents"
          desc="Per-agent on-chain identity and operating wallet."
        />
        <Card variant="recessed" padding="md">
          <p className="text-[12px] text-white/55 leading-relaxed">
            No agents deployed yet. Deploy an agent from the Agents window
            first.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <WalletTab agent={agent} onReloadMe={onReloadMe} />
    </div>
  );
}

function RegistrySection({
  company,
  agents,
  onReloadMe,
}: {
  company: CompanyDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const companyAnchored = !!company.companyPda;
  // The 3-phase wizard anchors company + CEO identity + CEO deployment.
  // We treat "setup complete" as the CEO being fully anchored — that's
  // the only state where all 3 phases are guaranteed done. Mid-flow
  // (e.g. company anchored but identity not) keeps the trigger visible
  // so the user can resume.
  const ceo = agents.find((a) => a.role === CEO_ROLE);
  const setupComplete =
    ceo !== undefined && ceo.agentChainTxSignature !== null;
  const needsSetup = ceo !== undefined && !setupComplete;

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHeader
        title="Registry"
        desc="Solana account proving ownership of this company. Chain is the source of truth — DB only caches it."
      />

      {setupComplete ? (
        <Card variant="recessed" padding="sm">
          <div className="flex items-center gap-2 text-[12px] text-emerald-300">
            <Anchor className="size-3.5" />
            <span className="font-medium">
              Anchored on {CLUSTER_LABEL}
            </span>
          </div>
        </Card>
      ) : needsSetup ? (
        <SetupCard
          companyAnchored={companyAnchored}
          onOpen={() => setSetupOpen(true)}
        />
      ) : (
        <Alert variant="warning">
          <p className="font-semibold text-amber-300">Not anchored yet</p>
          <p className="mt-1 text-[11px] text-amber-200/70">
            Waiting for a CEO agent to be deployed. The company anchor flow
            runs together with the CEO anchor.
          </p>
        </Alert>
      )}

      {ceo && (
        <AnchorSetupModal
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          company={company}
          ceo={ceo}
          onComplete={onReloadMe}
        />
      )}

      <ChainRow
        label="Address (PDA)"
        value={company.companyPda}
        kind="address"
      />
      <ChainRow
        label="Owner wallet"
        value={company.ownerWallet}
        kind="address"
      />
      <ChainRow
        label="Create transaction"
        value={company.chainTxSignature}
        kind="tx"
      />
      <ChainRow
        label="Nonce"
        value={
          company.chainNonce !== null && company.chainNonce !== undefined
            ? String(company.chainNonce)
            : null
        }
        kind="raw"
        hint="PDA derivation counter"
      />
    </div>
  );
}

function ChainRow({
  label,
  value,
  kind,
  hint,
}: {
  label: string;
  value: string | null;
  kind: "address" | "tx" | "raw";
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-white/40">
          {label}
        </span>
        {hint && <span className="text-[10px] text-white/30">{hint}</span>}
      </div>
      {value === null ? (
        <span className="text-[12px] text-white/30">—</span>
      ) : (
        <div className="flex items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-3 py-1.5">
          <code className="flex-1 min-w-0 truncate text-[12px] font-mono text-white/85">
            {kind === "raw" ? value : shortenAddress(value, 6, 6)}
          </code>
          <CopyButton value={value} />
          {kind !== "raw" && (
            <>
              <ExplorerLink
                href={
                  kind === "address"
                    ? solscanAddressUrl(value)
                    : solscanTxUrl(value)
                }
                label="Solscan"
              />
              <ExplorerLink
                href={
                  kind === "address"
                    ? explorerAddressUrl(value)
                    : explorerTxUrl(value)
                }
                label="Explorer"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context) — silent; value is still
      // visible/selectable in the row.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className="shrink-0 rounded-md p-1 text-white/45 hover:bg-white/10 hover:text-white/80 transition-colors cursor-pointer"
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? (
        <Check className="size-3 text-emerald-300" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  );
}

function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-white/55 hover:bg-white/10 hover:text-white/85 transition-colors"
      title={`Open in ${label}`}
    >
      <ExternalLink className="size-2.5" />
      {label}
    </a>
  );
}
