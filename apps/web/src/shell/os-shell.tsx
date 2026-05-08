"use client";

import { useCallback, useEffect, useState } from "react";
import type { UseMeResult } from "@/hooks/use-me";
import {
  Building2,
  CheckSquare,
  CheckCircle2,
  Clock,
  FileText,
  Library,
  Settings,
  Users,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/features/auth/hooks/use-auth";
import { Dock } from "@/components/ui/dock";
import { FEATURES, IS_DEV_MODE } from "@/lib/env-flags";
import { TaskManager } from "@/features/tasks/components/task-manager";
import { AgentsWindow } from "@/features/agents/components/agents-window";
import { ApprovalsWindow } from "@/features/approvals/components/approvals-window";
import { CompanyWindow } from "@/features/companies/components/company-window";
import { SkillLibrary } from "@/features/skills/components/skill-library";
import { RoutinesWindow } from "@/components/routines-window";
import { SettingsWindow } from "@/components/settings-window";
import { ChangelogsWindow } from "@/components/changelogs-window";
import { DevWindow } from "@/features/dev-tools/components/dev-window";

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
    | "approvals"
    | "company"
    | "skills"
    | "routines"
    | "changelogs"
    | "settings"
    | "dev";
  const [activeWindow, setActiveWindow] = useState<WindowId | null>(null);

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
  // can return to idle. Other windows close without touching focus.
  const closeAgentsWindow = useCallback(() => {
    setActiveWindow(null);
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
            icon: <Users className="size-5" />,
            label: "Agents",
            active: activeWindow === "agents",
            onClick: () => toggle("agents"),
          },
          {
            icon: <CheckCircle2 className="size-5" />,
            label: "Approvals",
            active: activeWindow === "approvals",
            onClick: () => toggle("approvals"),
          },
          {
            icon: <Library className="size-5" />,
            label: "Skills",
            active: activeWindow === "skills",
            disabled: !FEATURES.skills,
            disabledHint: "coming soon",
            onClick: () => toggle("skills"),
          },
          {
            icon: <Clock className="size-5" />,
            label: "Routines",
            active: activeWindow === "routines",
            disabled: !FEATURES.routines,
            disabledHint: "coming soon",
            onClick: () => toggle("routines"),
          },
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
          initialAgentId={focusedAgentId ?? null}
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
      {activeWindow === "skills" && FEATURES.skills && (
        <SkillLibrary onClose={close} onReloadMe={me.reload} />
      )}
      {activeWindow === "routines" && FEATURES.routines && (
        <RoutinesWindow agents={me.agents} onClose={close} />
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
    </>
  );
}
