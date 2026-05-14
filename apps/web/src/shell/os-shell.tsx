"use client";

import { useCallback, useEffect, useState } from "react";
import type { UseMeResult } from "@/hooks/use-me";
import {
  Brain,
  Building2,
  CheckSquare,
  CheckCircle2,
  FileText,
  Files,
  Network,
  Settings,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { Dock } from "@/components/ui/dock";
import { FEATURES, IS_DEV_MODE } from "@/lib/env-flags";
import { TaskManager } from "@/features/tasks/components/task-manager";
import { AgentsWindow } from "@/features/agents/components/agents-window";
import { ApprovalsWindow } from "@/features/approvals/components/approvals-window";
import { CompanyWindow } from "@/features/companies/components/company-window";
import { OrgChartWindow } from "@/features/agents/components/org-chart-window";
import { WorkflowsWindow } from "@/features/workflows/components/workflows-window";
import { SettingsWindow } from "@/components/settings-window";
import { ChangelogsWindow } from "@/components/changelogs-window";
import { DevWindow } from "@/features/dev-tools/components/dev-window";
import { BrainWindow } from "@/features/company-brain/components/brain-window";
import { DocumentsWindow } from "@/features/documents/components/documents-window";
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
}: OsShellProps) {
  const { status: authStatus } = useAuth();
  const authenticated = authStatus === "authenticated";
  type WindowId =
    | "tasks"
    | "agents"
    | "org-chart"
    | "approvals"
    | "company"
    | "company-brain"
    | "documents"
    | "skills"
    | "routines"
    | "workflows"
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

  if (!authenticated || !me.company) return null;

  const agentList = me.agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
  }));

  const toggle = (id: WindowId) => {
    setActiveWindow((prev) => {
      const next = prev === id ? null : id;
      // Toggling AgentsWindow off counts as closing it.
      if (id === "agents" && next === null) onClearFocus?.();
      // Toggling ApprovalsWindow off drops any pending deep-link target so
      // the next open starts on the natural first-pending row.
      if (id === "approvals" && next === null) onClearPendingApproval?.();
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
            onClick: () => toggle("approvals"),
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
          // Skills + Routines hidden from the dock for now to keep the
          // rail short. Both are still "coming soon" feature-flagged
          // and accessible via Library/Clock import sites if needed.
          // Restore when fully shipped.
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
          onClose={closeApprovalsWindow}
        />
      )}
      {activeWindow === "company" && (
        <CompanyWindow companyId={me.company.id} onClose={close} />
      )}
      {activeWindow === "company-brain" && <BrainWindow onClose={close} />}
      {activeWindow === "documents" && <DocumentsWindow onClose={close} />}
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
          onReset={me.reload}
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
      <CeoChatBubble agents={agentList} />
    </>
  );
}
