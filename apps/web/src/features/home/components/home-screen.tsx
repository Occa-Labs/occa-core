"use client";

import { useState } from "react";
import {
  Building2,
  Bot,
  LogOut,
  UserPlus,
  ArrowRight,
  Store,
  Plus,
  Users,
} from "lucide-react";
import type { AgentDTO, CompanyDTO } from "@occa/shared/types";
import { OccaLogo } from "@/components/icons/occa-logo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { AppWindow } from "@/components/ui/app-window";
import { Dock, type DockItem } from "@/components/ui/dock";
import { OCCA_CREATE_GATE_PERCENT } from "@/lib/env-flags";

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

interface HomeScreenProps {
  company: CompanyDTO | null;
  agents: AgentDTO[];
  loading: boolean;
  walletAddress: string | null;
  /** Open the selected company's 3D OS. */
  onEnterCompany: () => void;
  /** Open the deploy-agent flow. */
  onAddAgent: () => void;
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
      icon: <UserPlus className={iconCls} />,
      label: "Join a company",
      disabled: true,
      disabledHint: "coming soon",
      onClick: () => {},
    },
    {
      icon: <Store className={iconCls} />,
      label: "Marketplace",
      disabled: true,
      disabledHint: "coming soon",
      onClick: () => {},
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
        {walletAddress && (
          <span className="flex h-8 items-center gap-2 rounded-full bg-white/10 px-3 font-mono text-xs text-white/85">
            {truncate(walletAddress)}
          </span>
        )}
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
              onEnterCompany={onEnterCompany}
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
  onEnterCompany,
}: {
  company: CompanyDTO | null;
  onEnterCompany: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {company ? (
        <Card padding="lg" className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-white/8">
              <Building2 className="size-5 text-white/80" />
            </div>
            <Badge variant="success">Personal</Badge>
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-white">
              {company.name}
            </h3>
            <p className="mt-1 line-clamp-2 text-xs text-white/45">
              {company.tagline ?? "Your personal workspace."}
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
        <Card
          padding="lg"
          className="flex min-h-44 flex-col items-center justify-center gap-2 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-white/8">
            <Building2 className="size-5 text-white/60" />
          </div>
          <p className="text-sm font-medium text-white/70">
            No workspace yet
          </p>
          <p className="max-w-xs text-xs text-white/40">
            Add your first agent and your personal workspace is created
            automatically.
          </p>
        </Card>
      )}

      {/* Shareable multi-user company — the gated path (1% of $OCCA
          supply), landing in a later phase. */}
      <Card
        padding="lg"
        className="flex min-h-44 flex-col items-center justify-center gap-2 text-center opacity-60"
      >
        <div className="flex size-11 items-center justify-center rounded-2xl bg-white/8">
          <Users className="size-5 text-white/60" />
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-white/80">
            Create a company
          </p>
          <Badge variant="muted">Soon</Badge>
        </div>
        <p className="max-w-xs text-xs text-white/40">
          Shareable company others can join. Requires holding{" "}
          {OCCA_CREATE_GATE_PERCENT}% of $OCCA supply.
        </p>
      </Card>
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
    // Agents are free — no company required. Adding the first one
    // auto-provisions the user's personal workspace behind the scenes.
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
