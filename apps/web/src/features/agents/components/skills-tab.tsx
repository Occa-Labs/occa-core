"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, RefreshCw } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useSkills } from "@/features/skills/api/use-skills";
import { useAgentSkills } from "@/features/agents/api/use-agent-skills";
import { useAgentSkillSyncs } from "@/features/agents/api/use-agent-skill-syncs";
import { SkillDetailModal } from "@/features/skills/components/skill-library";
import { ApiError } from "@/lib/api";
import type {
  AgentDTO,
  AgentSkillSyncDTO,
  AgentSkillSyncStatus,
  SkillDTO,
} from "@occa/shared/types";
import { roleAllows } from "./_shared";

type SaveState = "idle" | "saving" | "saved" | "error";

const SYNC_STATUS_STYLE: Record<
  AgentSkillSyncStatus,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "bg-white/10 text-white/50" },
  installing: {
    label: "Installing…",
    className: "bg-sky-500/15 text-sky-300 animate-pulse",
  },
  installed: {
    label: "Installed",
    className: "bg-emerald-500/15 text-emerald-300",
  },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-300" },
  outdated: { label: "Outdated", className: "bg-amber-500/15 text-amber-200" },
  skill_deleted: {
    label: "Skill deleted",
    className: "bg-red-500/10 text-red-300/70",
  },
};

function SyncBadge({ sync }: { sync: AgentSkillSyncDTO }) {
  const s = SYNC_STATUS_STYLE[sync.status];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${s.className}`}
      title={sync.lastError ?? undefined}
    >
      {s.label}
    </span>
  );
}

export function SkillsTab({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useSkills(true, { role: agent.role });
  // Full company library (every role). Used to tell a genuinely deleted
  // skill (true orphan) apart from one that's simply assigned outside this
  // role's default set — the CEO/operator added the latter deliberately, so
  // it should render as a real skill, not as "missing from library".
  const { skills: allSkills, loading: libraryLoading } = useSkills(true);
  const { syncDesiredSkills } = useAgentSkills(onReloadMe);
  const {
    syncs,
    loading: syncsLoading,
    resync,
    reload: reloadSyncs,
  } = useAgentSkillSyncs(agent.id, true);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(agent.desiredSkills),
  );
  const [save, setSave] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [detailSkill, setDetailSkill] = useState<SkillDTO | null>(null);
  const [resyncing, setResyncing] = useState<Set<string>>(new Set());

  // Reset local selection when agent switches
  useEffect(() => {
    setSelected(new Set(agent.desiredSkills));
    setSave("idle");
    setErrorMsg(null);
  }, [agent.id, agent.desiredSkills]);

  const pendingRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    setSave("saving");
    setErrorMsg(null);
    try {
      await syncDesiredSkills(agent.id, Array.from(next));
      setSave("saved");
      // Reload syncs so new pending rows appear immediately
      void reloadSyncs();
      setTimeout(() => {
        setSave((s) => (s === "saved" ? "idle" : s));
      }, 1200);
    } catch (e) {
      setSave("error");
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; keys?: string[] } | null;
        if (body?.error === "unknown_skill_keys") {
          setErrorMsg(`Unknown skill keys: ${(body.keys ?? []).join(", ")}`);
        } else {
          setErrorMsg(body?.error ?? `http_${e.status}`);
        }
      } else {
        setErrorMsg("network_error");
      }
    }
  }, [agent.id, syncDesiredSkills, reloadSyncs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const toggle = useCallback(
    (key: string, disallowed?: boolean) => {
      if (disallowed) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        pendingRef.current = next;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          void flush();
        }, 500);
        return next;
      });
    },
    [flush],
  );

  const handleResync = useCallback(
    async (skillKey: string) => {
      setResyncing((prev) => new Set(prev).add(skillKey));
      try {
        await resync(skillKey, "reinstall");
      } finally {
        setResyncing((prev) => {
          const next = new Set(prev);
          next.delete(skillKey);
          return next;
        });
      }
    },
    [resync],
  );

  // Build a map of skillKey → sync row for fast lookup
  const syncMap = useMemo(
    () => new Map(syncs.map((s) => [s.skillKey, s])),
    [syncs],
  );

  // Partition into: skills shown in the toggle list vs true orphans.
  // `available` = this role's default-scoped skills PLUS any assigned skill
  // that exists in the full company library but falls outside the role
  // scope (deliberately added — render it as a real, toggleable skill).
  // `orphans` = assigned keys with NO library row at all (skill deleted).
  const { available, orphans } = useMemo(() => {
    const roleKeys = new Set(skills.map((s) => s.key));
    const allByKey = new Map(allSkills.map((s) => [s.key, s]));
    const crossRole = Array.from(selected)
      .filter((k) => !roleKeys.has(k) && allByKey.has(k))
      .map((k) => allByKey.get(k)!);
    const orphanKeys = Array.from(selected).filter((k) => !allByKey.has(k));
    return { available: [...skills, ...crossRole], orphans: orphanKeys };
  }, [skills, allSkills, selected]);

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white/90">
            Available skills ({available.length})
          </h3>
          <p className="text-xs text-white/40 mt-0.5">
            Select which skills this agent can use. Changes save automatically.
          </p>
        </div>
        <SaveIndicator state={save} errorMsg={errorMsg} />
      </div>

      {skillsLoading || syncsLoading || libraryLoading ? (
        <div className="flex items-center gap-2 text-xs text-white/40 py-8 justify-center">
          <Loader2 className="size-3.5 animate-spin" /> Loading skills…
        </div>
      ) : skillsError ? (
        <div className="flex items-center gap-2 text-xs text-red-300/80 py-8 justify-center">
          <AlertCircle className="size-3.5" /> Failed to load library (
          {skillsError})
        </div>
      ) : available.length === 0 ? (
        <div className="glass-light rounded-lg p-4 text-xs text-white/50">
          No skills in the library yet. Open the Skill Library to import one.
        </div>
      ) : (
        <div className="space-y-1">
          {available.map((skill) => {
            const allowed = roleAllows(skill, agent.role);
            const sync = syncMap.get(skill.key) ?? null;
            const isResyncing = resyncing.has(skill.key);
            const showResync =
              sync &&
              (sync.status === "failed" ||
                sync.status === "outdated" ||
                sync.status === "skill_deleted");
            return (
              <SkillRow
                key={skill.id}
                skill={skill}
                agentRole={agent.role}
                checked={selected.has(skill.key)}
                disallowed={!allowed}
                sync={sync}
                isResyncing={isResyncing}
                showResync={!!showResync}
                onToggle={() => toggle(skill.key, !allowed)}
                onOpenDetail={() => setDetailSkill(skill)}
                onResync={() => void handleResync(skill.key)}
              />
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[11px] uppercase tracking-wide text-white/40">
            Assigned but missing from library ({orphans.length})
          </h4>
          <div className="space-y-1">
            {orphans.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between glass-light rounded-md px-3 py-2"
              >
                <span className="text-xs text-white/60 font-mono truncate">
                  {key}
                </span>
                <button
                  onClick={() => toggle(key)}
                  className="text-[11px] text-red-300/80 hover:text-red-300"
                >
                  Unassign
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {detailSkill && (
        <SkillDetailModal
          skill={detailSkill}
          onClose={() => setDetailSkill(null)}
        />
      )}
    </div>
  );
}

function SkillRow({
  skill,
  agentRole,
  checked,
  disallowed,
  sync,
  isResyncing,
  showResync,
  onToggle,
  onOpenDetail,
  onResync,
}: {
  skill: SkillDTO;
  agentRole: string;
  checked: boolean;
  disallowed: boolean;
  sync: AgentSkillSyncDTO | null;
  isResyncing: boolean;
  showResync: boolean;
  onToggle: () => void;
  onOpenDetail: () => void;
  onResync: () => void;
}) {
  const rolesLabel =
    skill.allowedRoles.length === 0
      ? "All roles"
      : skill.allowedRoles.map((r) => r.toUpperCase()).join(", ");

  const activeOn = checked && !disallowed;

  return (
    <div
      title={
        disallowed
          ? `Restricted to ${rolesLabel}. This agent's role is ${agentRole.toUpperCase()}.`
          : undefined
      }
      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
        disallowed ? "opacity-45" : activeOn ? "bg-white/8" : "hover:bg-white/4"
      }`}
    >
      <button
        type="button"
        onClick={onOpenDetail}
        className="flex-1 min-w-0 text-left cursor-pointer"
        aria-label={`View details for ${skill.name}`}
      >
        <div className="text-xs font-medium text-white/90 truncate flex items-center gap-1.5">
          {skill.name}
          {skill.allowedRoles.length > 0 && (
            <span
              className={`text-[9px] uppercase tracking-wide font-medium rounded px-1 py-0.5 ${
                disallowed
                  ? "bg-white/5 text-white/40"
                  : "bg-amber-500/10 text-amber-200/90"
              }`}
            >
              {rolesLabel}
            </span>
          )}
          {sync && checked && <SyncBadge sync={sync} />}
        </div>
        {skill.description && (
          <div className="text-[11px] text-white/55 line-clamp-2 mt-0.5">
            {skill.description}
          </div>
        )}
        <div className="text-[10px] text-white/40 font-mono truncate mt-0.5">
          {skill.key} · {skill.sourceRef.slice(0, 7)} ·{" "}
          {skill.fileInventory.length} file
          {skill.fileInventory.length !== 1 ? "s" : ""}
        </div>
        {sync?.lastError && sync.status === "failed" && (
          <div className="text-[10px] text-red-300/60 truncate mt-0.5">
            {sync.lastError}
          </div>
        )}
      </button>

      {checked && showResync && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResync();
          }}
          disabled={isResyncing}
          title={
            sync?.status === "skill_deleted"
              ? "Skill removed from library — click to queue uninstall"
              : sync?.status === "outdated"
                ? "Newer version available — click to reinstall"
                : "Retry installation"
          }
          className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-white/6 hover:bg-white/12 text-white/50 hover:text-white/80 disabled:opacity-40 transition-colors"
        >
          {isResyncing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {sync?.status === "skill_deleted"
            ? "Uninstall"
            : sync?.status === "outdated"
              ? "Update"
              : "Retry"}
        </button>
      )}

      <Toggle
        checked={checked}
        onChange={() => onToggle()}
        disabled={disallowed}
        loading={!!sync && sync.status === "pending"}
        aria-label={`${activeOn ? "Disable" : "Enable"} ${skill.name}`}
      />
    </div>
  );
}

function SaveIndicator({
  state,
  errorMsg,
}: {
  state: SaveState;
  errorMsg: string | null;
}) {
  if (state === "idle") return null;
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-white/50">
        <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-green-400/90">
        <Check className="size-3" /> Saved
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] text-red-300/90 max-w-xs truncate"
      title={errorMsg ?? undefined}
    >
      <AlertCircle className="size-3" /> {errorMsg ?? "Save failed"}
    </span>
  );
}
