"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { useMe, type UseMeResult } from "@/hooks/use-me";
import { useCompanyAgents } from "@/features/agents/api/use-company-agents";
import { Spinner } from "@/components/ui/spinner";
import { useViewMode } from "@/shell/view-mode-toggle";
import { TopMenuBar } from "@/shell/top-menu-bar";
import { DesktopOnlyGate } from "@/shell/desktop-only-gate";
import { OnboardingWindow } from "@/features/onboarding/components/onboarding-window";
import { LoginScreen } from "@/features/auth/components/login-screen";
import { HomeScreen } from "@/features/home/components/home-screen";
import { CreateCompanyModal } from "@/features/home/components/create-company-modal";
import { AgentChainPanel } from "@/features/chain/components/agent-chain-panel";
import { InboxPanel } from "@/features/chain/components/inbox-panel";
import { useIncomingInvites } from "@/features/chain/hooks/use-incoming-invites";
import { useOutgoingInvites } from "@/features/chain/hooks/use-outgoing-invites";
import { DeployAgentModal } from "@/features/agents/components/deploy-agent-modal";
import { AgentDetail } from "@/features/agents/components/agents-window";
import { Modal } from "@/components/ui/modal";
import type { SceneAgent } from "@/features/theater/types";
import { deriveAgentStatus } from "@/features/theater/utils";
import { CEO_ROLE, getTier } from "@occa/shared/role-catalog";
import { usePersistentState } from "@/lib/persistent-state";

const OfficeScene = dynamic(
  () =>
    import("@/features/theater/components/office-scene").then(
      (mod) => mod.OfficeScene,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ background: "var(--app-bg-loading)" }}
      >
        <Spinner className="size-8 text-white" />
      </div>
    ),
  },
);

const OsShell = dynamic(
  () => import("@/shell/os-shell").then((mod) => mod.OsShell),
  { ssr: false },
);

export default function HomePage() {
  const { status: authStatus, user, signOut, updateName } = useAuth();
  const authenticated = authStatus === "authenticated";

  // Direct `useMe` — setup workflow is archived; the page now renders the
  // 3D office + OS chrome unconditionally for authed users. When the user
  // has no company yet, OsShell internally returns null and the scene
  // alone fills the viewport.
  const me = useMe(authenticated);

  // Cross-owner hire invites — both directions. Lifted to page level so the
  // home Inbox dock badge stays live even when the Inbox section isn't the
  // active surface. `incoming` = invites for agents this user owns (with
  // accept/decline); `outgoing` = invites this user sent (read-only outcome).
  const inbox = useIncomingInvites(me.reload);
  const outgoing = useOutgoingInvites();

  const hasCompany = !!me.company;
  // Onboarding stays open until a fully-provisioned CEO exists. The
  // window itself runs resume detection (re-pair vs. fresh) — page.tsx
  // only decides visibility.
  const ceo = me.agents.find((a) => getTier(a.role) === "ceo") ?? null;
  const onboardingRequired =
    !hasCompany || ceo === null || ceo.externalAgentId === null;

  // Per-session "I'll come back to this" flag — when the user closes the
  // onboarding window without finishing, we don't re-pop on every
  // me-refetch. State resets on reload, which is fine: a returning user
  // who still hasn't completed setup gets the window again.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const showOnboarding =
    authenticated && onboardingRequired && !onboardingDismissed && !me.loading;

  // Which surface the authed user sees: the personal dashboard (default)
  // or a company's 3D OS. Entering a company is explicit now — the OS is
  // no longer the post-login landing. Persisted so a refresh keeps the user
  // inside the OS instead of bouncing back to home.
  const [inCompany, setInCompany] = usePersistentState("occa_in_company", false);

  // Company-scoped agent list — every deployment at this company, including
  // cross-owner agents hired from the marketplace (which `/api/me` omits
  // because it's owner-scoped). The company OS reads this; the personal
  // home keeps `me.agents`.
  const companyAgents = useCompanyAgents(authenticated && inCompany);

  // The `me` object the OS shell consumes: same company/auth, but agents
  // swapped to the company-scoped list and `reload` refreshing both caches
  // so post-mutation refetches keep the office in sync.
  const osReload = useCallback(async () => {
    await Promise.all([me.reload(), companyAgents.reload()]);
  }, [me, companyAgents]);
  const osMe: UseMeResult = useMemo(
    () => ({ ...me, agents: companyAgents.agents, reload: osReload }),
    [me, companyAgents.agents, osReload],
  );

  // Deploy-agent modal, opened from the home screen's My agents section.
  // Lives here (app level) so features/home never imports features/agents
  // directly — composition happens in the page.
  const [deployOpen, setDeployOpen] = useState(false);

  // Create-company modal, opened from the home dashboard once the $OCCA
  // gate clears. App-level so features/home stays self-contained.
  const [createCompanyOpen, setCreateCompanyOpen] = useState(false);

  // Home agent detail. Stored by id (not the snapshot) so the modal
  // reflects live status after pause/reload and auto-closes when the
  // agent is retired (no longer in the list). Reuses the company OS's
  // rich AgentDetail (tabs + lifecycle) — composed here, not imported
  // by features/home.
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const detailAgent =
    detailAgentId !== null
      ? me.agents.find((a) => a.id === detailAgentId) ?? null
      : null;

  // 3D office vs flat background — driven purely by the user's view-mode
  // toggle now that there are no first-run cinematics owning the camera.
  const view = useViewMode();
  const showScene = view.enabled;

  // Build the per-agent scene roster. If no real CEO exists yet
  // (pre-deploy, empty company), synthesise a placeholder so the CEO desk
  // doesn't look empty in the 3D office.
  const agentsForScene: SceneAgent[] = useMemo(() => {
    const real = companyAgents.agents
      .filter((a) => a.provisioningState !== "failed")
      .map<SceneAgent>((a) => ({
        id: a.id,
        role: a.role,
        name: a.name,
        status: deriveAgentStatus(a),
        ready: a.provisioningState === "ready",
        workstationId: a.workstationId,
        createdAt: a.createdAt,
        modelOverride: a.modelOverride,
      }));

    if (!real.some((a) => a.role === CEO_ROLE)) {
      real.unshift({
        id: "placeholder-ceo",
        role: CEO_ROLE,
        name: "CEO",
        status: "idle",
        ready: false,
        workstationId: null,
        // Sort to the start so the placeholder claims CEO's preferred
        // model before any real agent.
        createdAt: "0000-01-01T00:00:00.000Z",
        modelOverride: null,
      });
    }
    return real;
  }, [companyAgents.agents]);

  // Click-to-focus state shared between the 3D office and OsShell. Click
  // an agent in the scene → set focusedAgentId → OsShell auto-opens
  // AgentsWindow with that agent selected, and the 3D camera lerps to
  // the agent's desk via focusedAgentRole. Clearing returns the camera
  // to overview and lets the user close the window normally.
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);

  const focusedAgentRole = useMemo(() => {
    if (!focusedAgentId) return null;
    return (
      companyAgents.agents.find((a) => a.id === focusedAgentId)?.role ?? null
    );
  }, [focusedAgentId, companyAgents.agents]);

  const handleAgentClick = useCallback((agentId: string) => {
    setFocusedAgentId(agentId);
  }, []);

  const handleClearFocus = useCallback(() => {
    setFocusedAgentId(null);
  }, []);

  // Dev-only: waypoint recorder for capturing Jia's walk paths. Toggled
  // from the Dev window's "Record" tab.
  const [devWalkRecord, setDevWalkRecord] = useState(false);
  const handleToggleWalkRecord = useCallback(() => {
    setDevWalkRecord((v) => !v);
  }, []);

  // "Room Tour" cinematic — Jia walks the recorded tour path then
  // returns. Triggered from Settings; only meaningful once the user has
  // a company (the path is anchored to office props that exist either way,
  // but UX-wise it's a "your office" tour).
  const [tourActive, setTourActive] = useState(false);
  const [tourDialog, setTourDialog] = useState<string | null>(null);
  const handleStartTour = useCallback(() => {
    if (!hasCompany) return;
    setTourActive(true);
    setTourDialog(null);
  }, [hasCompany]);
  const handleTourEnd = useCallback(() => {
    setTourActive(false);
    setTourDialog(null);
  }, []);
  const handleTourDialog = useCallback((text: string) => {
    setTourDialog(text);
  }, []);
  const clearTourDialog = useCallback(() => {
    setTourDialog(null);
  }, []);
  useEffect(() => {
    if (!hasCompany && tourActive) setTourActive(false);
  }, [hasCompany, tourActive]);

  // Dev-only: focus the camera on a workstation (chair+desk pair).
  const [focusedWorkstationId, setFocusedWorkstationId] = useState<
    string | null
  >(null);

  // Deep-link state driven by NotificationCenter card clicks. Each link
  // window maps to one slot of OsShell state; the dispatcher below
  // routes by parsed.window.
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(
    null,
  );
  const [pendingChainSection, setPendingChainSection] = useState<
    string | null
  >(null);
  const handleClearPendingApproval = useCallback(
    () => setPendingApprovalId(null),
    [],
  );
  const handleClearPendingChain = useCallback(
    () => setPendingChainSection(null),
    [],
  );
  const handleNavigate = useCallback(
    (parsed: import("@/features/notifications/utils").ParsedNotificationLink) => {
      switch (parsed.window) {
        case "approvals":
          if (parsed.target) setPendingApprovalId(parsed.target);
          break;
        case "chain":
          // "chain:treasury" / "chain:registry" etc. — target is the
          // section id. Missing target opens the default section.
          setPendingChainSection(parsed.target ?? "registry");
          break;
        // Other windows (agents, tasks, ...) wire in as their consumers
        // add deep-link entry points. Unknown windows are no-ops.
        default:
          break;
      }
    },
    [],
  );
  const handleFocusWorkstation = useCallback((id: string | null) => {
    setFocusedWorkstationId(id);
  }, []);

  // Dev-only: per-role overrides for workstation and animation status.
  type AgentDevOverridesShape = Record<
    string,
    {
      workstationId?: string | null;
      status?: "idle" | "working" | "talking" | "meeting" | null;
    }
  >;
  const [agentDevOverrides, setAgentDevOverrides] =
    usePersistentState<AgentDevOverridesShape>("occa.dev.agent-overrides", {});
  const updateAgentDevOverride = useCallback(
    (
      role: string,
      patch: {
        workstationId?: string | null;
        status?: "idle" | "working" | "talking" | "meeting" | null;
      },
    ) => {
      setAgentDevOverrides((prev) => ({
        ...prev,
        [role]: { ...prev[role], ...patch },
      }));
    },
    [],
  );

  // Outermost gate: until the user is authenticated, the only thing that
  // renders is the login wall. The 3D office, top bar, dock, and OS shell
  // do not mount behind it — login is the first surface, not a button
  // nested inside the desktop.
  if (!authenticated) {
    return (
      <DesktopOnlyGate>
        <LoginScreen />
      </DesktopOnlyGate>
    );
  }

  return (
    <DesktopOnlyGate>
      {inCompany ? (
          <main
            className="fixed inset-0 h-screen w-screen overflow-hidden"
            style={{ background: "var(--app-bg-scene)" }}
          >
            {showScene ? (
              <OfficeScene
                agents={agentsForScene}
                focusedAgentRole={focusedAgentRole}
                focusedWorkstationId={focusedWorkstationId}
                agentDevOverrides={agentDevOverrides}
                onAgentClick={handleAgentClick}
                tourActive={tourActive}
                onTourEnd={handleTourEnd}
                tourDialog={tourDialog}
                onTourDialog={handleTourDialog}
                onTourDialogDismiss={clearTourDialog}
                devWalkRecord={devWalkRecord}
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: "url(/images/background.jpg)",
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                }}
              />
            )}
            <TopMenuBar
              notificationsEnabled={hasCompany}
              viewMode3d={view.enabled}
              onToggleViewMode={view.toggle}
              viewModeToggleEnabled={true}
              onNavigate={handleNavigate}
              onExitCompany={() => setInCompany(false)}
            />
            {showOnboarding && (
              <OnboardingWindow
                me={me}
                onDismiss={() => setOnboardingDismissed(true)}
              />
            )}
            <OsShell
              me={osMe}
              focusedAgentId={focusedAgentId}
              onClearFocus={handleClearFocus}
              focusedWorkstationId={focusedWorkstationId}
              onFocusWorkstation={handleFocusWorkstation}
              agentDevOverrides={agentDevOverrides}
              onUpdateAgentDevOverride={updateAgentDevOverride}
              onStartTour={handleStartTour}
              tourActive={tourActive}
              devWalkRecord={devWalkRecord}
              onToggleWalkRecord={handleToggleWalkRecord}
              pendingApprovalId={pendingApprovalId}
              onClearPendingApproval={handleClearPendingApproval}
              pendingChainSection={pendingChainSection}
              onClearPendingChain={handleClearPendingChain}
            />
          </main>
        ) : (
        <>
          <HomeScreen
            company={me.company}
            agents={me.agents}
            loading={me.loading}
            walletAddress={user?.walletAddress ?? null}
            userName={user?.name ?? null}
            onUpdateName={updateName}
            onEnterCompany={() => setInCompany(true)}
            onAddAgent={() => setDeployOpen(true)}
            onCreateCompany={() => setCreateCompanyOpen(true)}
            onOpenAgentDetail={(a) => setDetailAgentId(a.id)}
            onSignOut={signOut}
            inboxCount={inbox.pendingCount}
            inboxSlot={<InboxPanel incoming={inbox} outgoing={outgoing} />}
            onInviteSent={outgoing.reload}
          />
          <DeployAgentModal
            open={deployOpen}
            onClose={() => setDeployOpen(false)}
            onDeployed={() => {
              void me.reload();
              setDeployOpen(false);
            }}
            agents={me.agents}
            showBilling={false}
            showRole={false}
          />
          <CreateCompanyModal
            open={createCompanyOpen}
            onClose={() => setCreateCompanyOpen(false)}
            onCreated={() => {
              void me.reload();
              setCreateCompanyOpen(false);
            }}
          />
          <Modal
            open={detailAgent !== null}
            onClose={() => setDetailAgentId(null)}
            title="Agent"
            width="min(680px, 94vw)"
            maxHeight="min(680px, 86vh)"
          >
            {detailAgent && (
              <div className="flex h-[min(580px,74vh)] flex-col">
                <AgentDetail
                  agent={detailAgent}
                  agents={me.agents}
                  onReloadMe={me.reload}
                  // Show the agent's actual company name whenever it is
                  // assigned to one (personal company included — to the
                  // owner it's a real company). Only a truly company-less
                  // agent (companyId null) reads as "Not assigned /
                  // Available". Single-company today: the only loaded company
                  // is me.company; per-agent name lookup across many
                  // companies arrives with Phase 4.
                  companyLabel={
                    detailAgent.companyId &&
                    me.company?.id === detailAgent.companyId
                      ? me.company.name
                      : null
                  }
                  hideSeating
                  chainTabSlot={
                    <AgentChainPanel
                      agent={detailAgent}
                      onReload={me.reload}
                    />
                  }
                />
              </div>
            )}
          </Modal>
        </>
      )}
    </DesktopOnlyGate>
  );
}
