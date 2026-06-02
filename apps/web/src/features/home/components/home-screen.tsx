"use client";

import { useState } from "react";
import {
  Building2,
  Bot,
  LogOut,
  ArrowRight,
  Plus,
  Copy,
  Check,
} from "lucide-react";
import type { AgentDTO, CompanyDTO } from "@occa/shared/types";
import { OccaLogo } from "@/components/icons/occa-logo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { AppWindow } from "@/components/ui/app-window";
import { Dock, type DockItem } from "@/components/ui/dock";
import { CreateCompanyCard } from "./create-company-card";

// The personal home shown right after login — before any company OS.
// Follows the OCCA macOS layout (not an admin dashboard): a wallpaper
// desktop, a thin top bar, a floating glass window for content, and the
// bottom dock for navigation. Company-agnostic: lists the companies the
// user belongs to and the agents they own, and is the launch point into
// a company's 3D OS.

type HomeSection = "companies" | "agents";

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// Click-to-copy wallet pill for the home top bar. Mirrors the company
// shell's wallet behavior (copy the full address) without importing the
// auth feature — feature boundaries forbid that, so this stays local.
function WalletPill({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — silent */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy address"}
      aria-label={copied ? "Address copied" : "Copy address"}
      className="flex h-8 cursor-pointer items-center gap-2 rounded-full bg-white/10 px-3 font-mono text-xs text-white/85 transition-colors hover:bg-white/15"
    >
      {truncate(address)}
      {copied ? (
        <Check className="size-3 text-emerald-400" />
      ) : (
        <Copy className="size-3 text-white/55" />
      )}
    </button>
  );
}

interface HomeScreenProps {
  company: CompanyDTO | null;
  agents: AgentDTO[];
  loading: boolean;
  walletAddress: string | null;
  /** Open the selected company's 3D OS. */
  onEnterCompany: () => void;
  /** Open the deploy-agent flow. */
  onAddAgent: () => void;
  /** Open the create-company flow (fired after the $OCCA gate clears). */
  onCreateCompany: () => void;
  /** Open the full agent detail (rendered at app level). */
  onOpenAgentDetail: (agent: AgentDTO) => void;
  onSignOut: () => void;
}

export function HomeScreen({
  company,
  agents,
  loading,
  walletAddress,
  onEnterCompany,
  onAddAgent,
  onCreateCompany,
  onOpenAgentDetail,
  onSignOut,
}: HomeScreenProps) {
  const [section, setSection] = useState<HomeSection>("agents");

  const iconCls = "size-5";
  const dockItems: DockItem[] = [
    {
      icon: <Bot className={iconCls} />,
      label: "My agents",
      active: section === "agents",
      onClick: () => setSection("agents"),
    },
    {
      icon: <Building2 className={iconCls} />,
      label: "My companies",
      active: section === "companies",
      onClick: () => setSection("companies"),
    },
    {
      icon: <LogOut className={iconCls} />,
      label: "Disconnect",
      onClick: onSignOut,
    },
  ];

  return (
    <main className="fixed inset-0 h-screen w-screen overflow-hidden">
      {/* Wallpaper desktop — shared with the login surface */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url(/images/background.jpg)",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 20%, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.66) 100%)",
        }}
      />

      {/* Top bar — OCCA wordmark left, wallet right */}
      <div className="fixed inset-x-3 top-2 z-50 flex items-center justify-between text-white/70">
        <div className="flex items-center gap-2.5 pl-2">
          <OccaLogo width={22} height={22} className="text-white/85" />
          <span className="text-sm font-semibold tracking-tight text-white/85">
            OCCA
          </span>
        </div>
        {walletAddress && <WalletPill address={walletAddress} />}
      </div>

      {/* Content window */}
      <AppWindow
        title={section === "companies" ? "My companies" : "My agents"}
        subtitle={
          section === "companies"
            ? "Companies you own or contribute to"
            : "Agents you own, and where they're deployed"
        }
        disableClose
        defaultSize={{ w: 780, h: 540 }}
        zIndex={30}
        headerRight={
          section === "agents" ? (
            <Button variant="secondary" size="sm" onClick={onAddAgent}>
              <Plus className="size-3.5" />
              Add agent
            </Button>
          ) : undefined
        }
      >
        <div className="p-6">
          {loading ? (
            <div className="flex h-48 items-center justify-center">
              <Spinner className="size-7 text-white/60" />
            </div>
          ) : section === "companies" ? (
            <CompaniesSection
              company={company}
              walletAddress={walletAddress}
              onEnterCompany={onEnterCompany}
              onCreateCompany={onCreateCompany}
            />
          ) : (
            <AgentsSection
              agents={agents}
              onAddAgent={onAddAgent}
              onSelect={onOpenAgentDetail}
            />
          )}
        </div>
      </AppWindow>

      <Dock items={dockItems} />
    </main>
  );
}

function CompaniesSection({
  company,
  walletAddress,
  onEnterCompany,
  onCreateCompany,
}: {
  company: CompanyDTO | null;
  walletAddress: string | null;
  onEnterCompany: () => void;
  onCreateCompany: () => void;
}) {
  // One company per user today: show the company if it exists, otherwise
  // the gated create CTA. Never both at once — there's nothing to create
  // once you already own one.
  return (
    <div className="mx-auto max-w-md">
      {company ? (
        <Card padding="lg" className="flex flex-col gap-4">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-white/8">
            <Building2 className="size-5 text-white/80" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-white">
              {company.name}
            </h3>
            <p className="mt-1 line-clamp-2 text-xs text-white/45">
              {company.tagline ?? "Your company."}
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            block
            onClick={onEnterCompany}
            className="mt-auto"
          >
            Enter
            <ArrowRight className="size-4" />
          </Button>
        </Card>
      ) : (
        <CreateCompanyCard
          hasCompany={false}
          walletAddress={walletAddress}
          onProceed={onCreateCompany}
        />
      )}
    </div>
  );
}

function AgentsSection({
  agents,
  onAddAgent,
  onSelect,
}: {
  agents: AgentDTO[];
  onAddAgent: () => void;
  onSelect: (agent: AgentDTO) => void;
}) {
  if (agents.length === 0) {
    // Agents are free and independent — they live here at the user level
    // (idle until deployed into a company; no company auto-created).
    return (
      <Card
        padding="lg"
        className="flex flex-col items-center gap-3 py-12 text-center"
      >
        <Bot className="size-7 text-white/35" />
        <p className="text-sm font-medium text-white/70">No agents yet</p>
        <p className="max-w-xs text-xs text-white/40">
          Deploy your first agent to put it to work.
        </p>
        <Button variant="primary" size="lg" onClick={onAddAgent}>
          <Plus className="size-4" />
          Add agent
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((a) => (
        <Card
          key={a.id}
          interactive
          padding="md"
          onClick={() => onSelect(a)}
          className="flex items-center gap-3"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/8">
            <Bot className="size-5 text-white/75" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">
              {a.name}
            </p>
            <p
              className={`truncate text-xs text-white/45 ${a.persona ? "" : "capitalize"}`}
            >
              {a.persona ?? a.role}
            </p>
          </div>
          <Badge variant={a.status === "active" ? "success" : "muted"}>
            {a.status}
          </Badge>
        </Card>
      ))}
    </div>
  );
}
