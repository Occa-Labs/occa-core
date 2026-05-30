"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { UseMeResult } from "@/hooks/use-me";
import {
  Anchor,
  Brain,
  Building2,
  CalendarClock,
  CheckSquare,
  CheckCircle2,
  FileText,
  Files,
  Library,
  MessagesSquare,
  Network,
  Plug,
  Settings,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { Dock } from "@/components/ui/dock";
import { FEATURES, IS_DEV_MODE } from "@/lib/env-flags";
import { isAdapterType } from "@occa/shared/types";
import { TaskManager } from "@/features/tasks/components/task-manager";
import { AgentsWindow } from "@/features/agents/components/agents-window";
import {
  DeployAgentModal,
  type DeployPrefill,
} from "@/features/agents/components/deploy-agent-modal";
import { ApprovalsWindow } from "@/features/approvals/components/approvals-window";
import { useDecideApproval } from "@/features/approvals/api/use-decide-approval";
import { useApprovalsList } from "@/features/approvals/api/use-approvals-list";
import type { DeployProposalRequest } from "@/features/approvals/utils";
import { CompanyWindow } from "@/features/companies/components/company-window";
import { ChainWindow } from "@/features/chain/components/chain-window";
import { OrgChartWindow } from "@/features/agents/components/org-chart-window";
import { WorkflowsWindow } from "@/features/workflows/components/workflows-window";
import { RoutinesWindow } from "@/features/routines/components/routines-window";
import { SettingsWindow } from "@/components/settings-window";
import { ChangelogsWindow } from "@/components/changelogs-window";
import { DevWindow } from "@/features/dev-tools/components/dev-window";
import { BrainWindow } from "@/features/company-brain/components/brain-window";
import { DocumentsWindow } from "@/features/documents/components/documents-window";
import { ChatsWindow } from "@/features/chats/components/chats-window";
import { SkillLibrary } from "@/features/skills/components/skill-library";
import { ToolsWindow } from "@/features/tools/components/tools-window";
import { CeoChatBubble } from "./ceo-chat-bubble";

interface OsShellProps {
  /** Lifted from the parent so OsShell shares a single useMe instance with
   *  page.tsx. (TanStack Query would dedupe a second call by key, but we
   *  pass it down anyway so callbacks like `me.reload` are referentially
   *  stable across the tree.) */
  me: UseMeResult;
  /** When set, OsShell auto-opens AgentsWindow with this agent selected.
   *  Driven by clicks on agents in the 3D office. */
  focusedAgentId?: string | null;
  /** Called when the AgentsWindow is closed so the parent can drop the
   *  focus state and let the camera return to idle. */
  onClearFocus?: () => void;
  /** Currently dev-window-pinned workstation, surfaced so DevWindow can
   *  highlight the active row. */
  focusedWorkstationId?: string | null;
  /** Dev-only: DevWindow calls this to ask the camera to fly to a chair. */
  onFocusWorkstation?: (id: string | null) => void;
  /** Dev-only per-role overrides + setter for the Agents tab. */
  agentDevOverrides?: Record<
    string,
    {
      workstationId?: string | null;
      status?: "idle" | "working" | "talking" | "meeting" | null;
    }
  >;
  onUpdateAgentDevOverride?: (
    role: string,
    patch: {
      workstationId?: string | null;
      status?: "idle" | "working" | "talking" | "meeting" | null;
    },
  ) => void;
  /** Settings-window button calls this to launch Jia's room-tour cinematic. */
  onStartTour?: () => void;
  /** Disables the tour button while a tour is already running. */
  tourActive?: boolean;
  /** Dev-only: waypoint recorder mode. True = WaypointRecorder is
   *  mounted in the scene + on-screen HUD visible. */
  devWalkRecord?: boolean;
  /** Dev-only: flips `devWalkRecord` from the Dev window's Record tab. */
  onToggleWalkRecord?: () => void;
  /** When set, OsShell auto-opens the Approvals window with this approval
   *  selected. Driven by "Open in Approvals" clicks in NotificationCenter. */
  pendingApprovalId?: string | null;
  /** Called when the Approvals window is closed so the parent can drop the
   *  pending-id state. */
  onClearPendingApproval?: () => void;
  /** When set, OsShell auto-opens the Chain window pre-selecting this
   *  section. Driven by treasury-readiness notification clicks. */
  pendingChainSection?: string | null;
  onClearPendingChain?: () => void;
}

// OS chrome: dock + windows. The first-run flow (onboarding wizard,
// kickoff dialog, hiring window) lives in `features/setup/` and is
// rendered by `<SetupWorkflow>` in app/page.tsx. OsShell only mounts when
// `phase === "live"` (i.e. kickoffState === "completed"), so it never
// needs to know about pre-live phases.
export function OsShell({
  me,
  focusedAgentId,
  onClearFocus,
  focusedWorkstationId = null,
  onFocusWorkstation,
  agentDevOverrides = {},
  onUpdateAgentDevOverride,
  onStartTour,
  tourActive = false,
  devWalkRecord = false,
  onToggleWalkRecord,
  pendingApprovalId = null,
  onClearPendingApproval,
  pendingChainSection = null,
  onClearPendingChain,
}: OsShellProps) {
  const { status: authStatus } = useAuth();
  const authenticated = authStatus === "authenticated";
  type WindowId =
    | "tasks"
    | "agents"
    | "org-chart"
    | "approvals"
    | "chats"
    | "company"
    | "chain"
    | "company-brain"
    | "documents"
    | "skills"
    | "routines"
    | "workflows"
    | "tools"
    | "changelogs"
    | "settings"
    | "dev";
  const [activeWindow, setActiveWindow] = useState<WindowId | null>(null);
  // Local agent-focus that lets OrgChartWindow (or anything else inside
  // the shell) request AgentsWindow open with a specific agent
  // pre-selected. Falls back to the upstream `focusedAgentId` prop when
  // unset so theater clicks still work.
  const [localAgentFocusId, setLocalAgentFocusId] = useState<string | null>(
    null,
  );
  const effectiveAgentFocusId = localAgentFocusId ?? focusedAgentId ?? null;

  // A CEO deployment proposal the operator chose to deploy ("Deploy this"
  // in Approvals). Non-null = the pre-filled deploy modal is open. The
  // modal collects the gateway endpoint + token (operator-only) and runs
  // the operator-signed deploy; the proposal carries ONLY catalog
  // selections, never credentials.
  const [deployProposal, setDeployProposal] =
    useState<DeployProposalRequest | null>(null);
  // Resolve a deployment proposal once the operator-signed deploy lands.
  // Using the feature's mutation (not the raw api client) so the pending
  // list drops the row immediately via its optimistic update + invalidate,
  // instead of lingering until the 15s poll.
  const decideApproval = useDecideApproval();

  // Pending-approvals count for the dock badge. Always-on (not gated on the
  // window being open) so the badge stays live even when Approvals is
  // closed; reuses the same 15s-polling query key as the window, so this
  // adds no extra network traffic when the window is also open.
  const { data: pendingApprovals } = useApprovalsList(authenticated, "pending");
  const pendingApprovalCount = pendingApprovals?.length ?? 0;

  // External focus request (theater click) → open AgentsWindow. Tracking
  // by id rather than truthy-check so re-clicking the same agent twice
  // still re-asserts the window when the user closed it manually.
  useEffect(() => {
    if (focusedAgentId) setActiveWindow("agents");
  }, [focusedAgentId]);

  // External "Open in Approvals" request from notification center.
  useEffect(() => {
    if (pendingApprovalId) setActiveWindow("approvals");
  }, [pendingApprovalId]);

  // Deep-link to the Chain window via notification (e.g. treasury readiness).
  useEffect(() => {
    if (pendingChainSection) setActiveWindow("chain");
  }, [pendingChainSection]);

  // Closing the AgentsWindow always clears upstream focus so the camera
  // can return to idle. Local agent-focus (set by OrgChart click) also
  // clears so a subsequent theater click isn't shadowed.
  const closeAgentsWindow = useCallback(() => {
    setActiveWindow(null);
    setLocalAgentFocusId(null);
    onClearFocus?.();
  }, [onClearFocus]);

  const closeApprovalsWindow = useCallback(() => {
    setActiveWindow(null);
    onClearPendingApproval?.();
  }, [onClearPendingApproval]);

  const closeChainWindow = useCallback(() => {
    setActiveWindow(null);
    onClearPendingChain?.();
  }, [onClearPendingChain]);

  // After the operator-signed deploy succeeds from a proposal: mark the
  // proposal resolved (approve runs no provisioning side effect for
  // propose_deployment — the agent was just provisioned above), refresh
  // the roster, and surface the new agent. Closing is best-effort; if it
  // fails the row stays pending and the Approvals list polls it away or
  // the operator dismisses it.
  const handleProposalDeployed = useCallback(
    async (newAgentId: string) => {
      const proposalId = deployProposal?.proposalId ?? null;
      setDeployProposal(null);
      if (proposalId) {
        try {
          await decideApproval.mutateAsync({
            id: proposalId,
            decision: "approve",
          });
        } catch {
          // ignore — on error the mutation restores the row to pending;
          // the operator can dismiss it manually
        }
      }
      await me.reload();
      setLocalAgentFocusId(newAgentId);
      setActiveWindow("agents");
    },
    [deployProposal, me, decideApproval],
  );

  // Memoized so the modal's seed effect (deps [open, prefill]) only fires
  // when the proposal actually changes — an inline object would get a new
  // identity on every shell re-render and re-seed over the operator's edits.
  const deployPrefill = useMemo<DeployPrefill | null>(() => {
    if (!deployProposal) return null;
    return {
      name: deployProposal.suggestedName ?? undefined,
      role: deployProposal.role || undefined,
      adapterType: isAdapterType(deployProposal.runtime)
        ? deployProposal.runtime
        : undefined,
      proposedSkills: deployProposal.desiredSkills,
    };
  }, [deployProposal]);

  if (!authenticated || !me.company) return null;

  const agentList = me.agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
  }));

  // Distinct roles currently deployed in this company. Threaded into the
  // role pickers (skill import, tool install/edit) so operators can pick
  // custom roles like `social_media_editor` without retyping the slug.
  const companyRoles = Array.from(new Set(me.agents.map((a) => a.role)));

  const toggle = (id: WindowId) => {
    setActiveWindow((prev) => {
      const next = prev === id ? null : id;
      // Toggling AgentsWindow off counts as closing it.
      if (id === "agents" && next === null) onClearFocus?.();
      // Toggling ApprovalsWindow off drops any pending deep-link target so
      // the next open starts on the natural first-pending row.
      if (id === "approvals" && next === null) onClearPendingApproval?.();
      // Same for Chain — close drops the pending section so a later
      // manual open lands on the default tab.
      if (id === "chain" && next === null) onClearPendingChain?.();
      return next;
    });
  };
  const close = () => setActiveWindow(null);

  return (
    <>
      <Dock
        items={[
          {
            icon: <Building2 className="size-5" />,
            label: "Company",
            active: activeWindow === "company",
            onClick: () => toggle("company"),
          },
          {
            icon: <Anchor className="size-5" />,
            label: "Chain",
            active: activeWindow === "chain",
            onClick: () => toggle("chain"),
          },
          {
            icon: <CheckSquare className="size-5" />,
            label: "Tasks",
            active: activeWindow === "tasks",
            disabled: !FEATURES.tasks,
            disabledHint: "coming soon",
            onClick: () => toggle("tasks"),
          },
          {
            icon: <Workflow className="size-5" />,
            label: "Workflows",
            active: activeWindow === "workflows",
            disabled: !FEATURES.workflows,
            disabledHint: "coming soon",
            onClick: () => toggle("workflows"),
          },
          {
            icon: <Users className="size-5" />,
            label: "Agents",
            active: activeWindow === "agents",
            onClick: () => toggle("agents"),
          },
          {
            icon: <Network className="size-5" />,
            label: "Org Chart",
            active: activeWindow === "org-chart",
            onClick: () => toggle("org-chart"),
          },
          {
            icon: <CheckCircle2 className="size-5" />,
            label: "Approvals",
            active: activeWindow === "approvals",
            badge: pendingApprovalCount,
            onClick: () => toggle("approvals"),
          },
          {
            icon: <MessagesSquare className="size-5" />,
            label: "Chats",
            active: activeWindow === "chats",
            onClick: () => toggle("chats"),
          },
          {
            icon: <Brain className="size-5" />,
            label: "Brain",
            active: activeWindow === "company-brain",
            onClick: () => toggle("company-brain"),
          },
          {
            icon: <Files className="size-5" />,
            label: "Documents",
            active: activeWindow === "documents",
            onClick: () => toggle("documents"),
          },
          // Skills — feature-flagged (FEATURES.skills hides it in
          // production until fully shipped). Routines stays out of the
          // dock until shipped.
          ...(FEATURES.skills
            ? [
                {
                  icon: <Library className="size-5" />,
                  label: "Skills",
                  active: activeWindow === "skills",
                  onClick: () => toggle("skills"),
                },
              ]
            : []),
          ...(FEATURES.routines
            ? [
                {
                  icon: <CalendarClock className="size-5" />,
                  label: "Routines",
                  active: activeWindow === "routines",
                  onClick: () => toggle("routines"),
                },
              ]
            : []),
          ...(FEATURES.tools
            ? [
                {
                  icon: <Plug className="size-5" />,
                  label: "Tools",
                  active: activeWindow === "tools",
                  onClick: () => toggle("tools"),
                },
              ]
            : []),
          ...(IS_DEV_MODE
            ? [
                {
                  icon: <Wrench className="size-5" />,
                  label: "Dev Tools",
                  active: activeWindow === "dev",
                  onClick: () => toggle("dev"),
                },
              ]
            : []),
          {
            icon: <FileText className="size-5" />,
            label: "Changelogs",
            active: activeWindow === "changelogs",
            onClick: () => toggle("changelogs"),
          },
          {
            icon: <Settings className="size-5" />,
            label: "Settings",
            active: activeWindow === "settings",
            onClick: () => toggle("settings"),
          },
        ]}
      />
      {activeWindow === "tasks" && FEATURES.tasks && (
        <TaskManager
          companyId={me.company.id}
          agentList={agentList}
          onClose={close}
        />
      )}
      {activeWindow === "agents" && (
        <AgentsWindow
          companyName={me.company.name}
          agents={me.agents}
          onReloadMe={me.reload}
          initialAgentId={effectiveAgentFocusId}
          onClose={closeAgentsWindow}
        />
      )}
      {activeWindow === "approvals" && (
        <ApprovalsWindow
          agents={me.agents}
          initialApprovalId={pendingApprovalId}
          onDeployProposal={setDeployProposal}
          onClose={closeApprovalsWindow}
        />
      )}
      {activeWindow === "company" && (
        <CompanyWindow companyId={me.company.id} onClose={close} />
      )}
      {activeWindow === "chain" && (
        <ChainWindow
          company={me.company}
          agents={me.agents}
          onReloadMe={me.reload}
          onClose={closeChainWindow}
          initialSection={
            (pendingChainSection ?? undefined) as
              | "registry"
              | "treasury"
              | "anchors"
              | "transactions"
              | "agents"
              | undefined
          }
        />
      )}
      {activeWindow === "company-brain" && <BrainWindow onClose={close} />}
      {activeWindow === "documents" && <DocumentsWindow onClose={close} />}
      {activeWindow === "skills" && FEATURES.skills && (
        <SkillLibrary
          onClose={close}
          onReloadMe={me.reload}
          extraRoles={companyRoles}
        />
      )}
      {activeWindow === "routines" && FEATURES.routines && (
        <RoutinesWindow agents={agentList} onClose={close} />
      )}
      {activeWindow === "tools" && FEATURES.tools && (
        <ToolsWindow
          companyId={me.company.id}
          companyName={me.company.name}
          onClose={close}
          extraRoles={companyRoles}
        />
      )}
      {activeWindow === "chats" && (
        <ChatsWindow agents={me.agents} onClose={close} />
      )}
      {activeWindow === "org-chart" && (
        <OrgChartWindow
          companyName={me.company.name}
          agents={me.agents}
          onClose={close}
          onOpenAgent={(agentId) => {
            setLocalAgentFocusId(agentId);
            setActiveWindow("agents");
          }}
        />
      )}
      {activeWindow === "workflows" && FEATURES.workflows && (
        <WorkflowsWindow onClose={close} />
      )}
      {activeWindow === "changelogs" && <ChangelogsWindow onClose={close} />}
      {activeWindow === "settings" && (
        <SettingsWindow
          onClose={close}
          onStartTour={onStartTour}
          tourActive={tourActive}
        />
      )}
      {activeWindow === "dev" && (
        <DevWindow
          onClose={close}
          focusedWorkstationId={focusedWorkstationId}
          onFocusWorkstation={onFocusWorkstation}
          agents={me.agents}
          agentDevOverrides={agentDevOverrides}
          onUpdateAgentDevOverride={onUpdateAgentDevOverride}
          devWalkRecord={devWalkRecord}
          onToggleWalkRecord={onToggleWalkRecord}
        />
      )}
      {/* Deploy modal driven by a CEO proposal. Mounted at the shell so
          the Approvals → Agents handoff composes across features without
          either importing the other. Credentials are entered here by the
          operator; the proposal only pre-seeds catalog choices. */}
      <DeployAgentModal
        open={deployProposal !== null}
        prefill={deployPrefill}
        agents={me.agents}
        onClose={() => setDeployProposal(null)}
        onDeployed={handleProposalDeployed}
      />
      <CeoChatBubble agents={agentList} />
    </>
  );
}
