"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  FileText,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Modal } from "@/components/ui/modal";
import { RoleMultiSelect } from "@/components/ui/role-multi-select";
import { useSkills } from "@/features/skills/api/use-skills";
import { ApiError } from "@/lib/api";
import {
  type AgentRole,
  type SkillDTO,
  type SkillFileEntry,
} from "@occa/shared/types";

interface SkillLibraryProps {
  onClose?: () => void;
  onReloadMe?: () => Promise<void> | void;
  // Roles to merge into the role picker beyond the static AGENT_ROLES
  // catalog. Typically distinct roles already in use by company
  // deployments. Without this, custom roles like `social_media_editor`
  // never surface as suggestions.
  extraRoles?: string[];
}

export function SkillLibrary({ onClose, onReloadMe, extraRoles }: SkillLibraryProps) {
  const { skills, loading, error, importSkill, updateRoles, remove, refresh } =
    useSkills(true);
  const [selected, setSelected] = useState<SkillDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillDTO | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const headerRight = (
    <button
      onClick={() => setImportOpen(true)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white/90 font-medium transition-colors"
    >
      <Plus className="size-3.5" /> Import Skill
    </button>
  );

  return (
    <>
      <AppWindow
        title="Skill Library"
        subtitle={`${skills.length} skill${skills.length !== 1 ? "s" : ""}`}
        onClose={onClose}
        headerRight={headerRight}
        defaultSize={{
          w: Math.min(980, Math.round(window.innerWidth * 0.8)),
          h: Math.min(720, Math.round(window.innerHeight * 0.82)),
        }}
      >
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-white/40 text-sm gap-2">
              <Loader2 className="size-4 animate-spin" /> Loading skills…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-40 text-red-300/80 text-sm gap-2">
              <AlertCircle className="size-4" /> Failed to load ({error})
            </div>
          ) : skills.length === 0 ? (
            <EmptyState onImport={() => setImportOpen(true)} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onOpen={() => setSelected(skill)}
                  onDelete={() => setPendingDelete(skill)}
                />
              ))}
            </div>
          )}
        </div>
      </AppWindow>

      {importOpen && (
        <ImportSkillModal
          extraRoles={extraRoles}
          onCancel={() => setImportOpen(false)}
          onSubmit={async (input) => {
            await importSkill(input);
            await onReloadMe?.();
            setImportOpen(false);
          }}
        />
      )}

      {selected && (
        <SkillDetailModal
          skill={selected}
          extraRoles={extraRoles}
          onClose={() => setSelected(null)}
          onUpdateRoles={async (roles) => {
            const updated = await updateRoles(selected.id, roles);
            setSelected(updated);
          }}
          onRefresh={async () => {
            const res = await refresh(selected.id);
            setSelected(res.skill);
            return res;
          }}
          onDelete={() => {
            setPendingDelete(selected);
            setSelected(null);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          skill={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const target = pendingDelete;
            setPendingDelete(null);
            try {
              await remove(target.id);
            } catch {
              /* swallow — reload will resurface error */
            }
          }}
        />
      )}
    </>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-60 gap-3 text-center">
      <div className="size-14 rounded-2xl glass flex items-center justify-center text-white/40">
        <BookOpen className="size-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm text-white/80 font-medium">No skills yet</p>
        <p className="text-xs text-white/40 max-w-xs">
          Import a skill from GitHub to give your agents reusable instructions
          and scripts.
        </p>
      </div>
      <button
        onClick={onImport}
        className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white/90 font-medium"
      >
        <Plus className="size-3.5" /> Import your first skill
      </button>
    </div>
  );
}

// ── Import modal ─────────────────────────────────────────────────────────────

function ImportSkillModal({
  onCancel,
  onSubmit,
  extraRoles,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    source: string;
    allowedRoles: AgentRole[];
  }) => Promise<void>;
  extraRoles?: string[];
}) {
  const [source, setSource] = useState("");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = source.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ source: trimmed, allowedRoles: roles });
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        setErr(body?.error ?? `http_${e.status}`);
      } else {
        setErr("network_error");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onSubmit, roles, source]);

  return (
    <Modal open onClose={busy ? () => {} : onCancel} widthClassName="max-w-lg">
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: "rgba(20, 20, 24, 0.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.10)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <h3 className="text-sm font-semibold text-white/90">Import Skill</h3>
          <button
            onClick={onCancel}
            disabled={busy}
            className="size-7 rounded-md hover:bg-white/10 text-white/50 hover:text-white/90 flex items-center justify-center disabled:opacity-40"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-white/50">
              Source
            </label>
            <div className="flex items-center gap-2 glass-light rounded-lg px-3 py-2">
              <Link2 className="size-4 text-white/40 shrink-0" />
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                placeholder="owner/repo/slug  or  https://github.com/owner/repo/tree/main/skills/name"
                disabled={busy}
                autoFocus
                className="flex-1 bg-transparent text-sm text-white/90 placeholder:text-white/30 focus:outline-none disabled:opacity-50"
              />
            </div>
            <p className="text-[11px] text-white/40">
              Fetches SKILL.md and pins to the current commit SHA.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-white/50">
              Allowed roles
            </label>
            <RoleMultiSelect
              value={roles}
              onChange={setRoles}
              disabled={busy}
              extraRoles={extraRoles}
            />
            <p className="text-[11px] text-white/40">
              Pick from presets or type a custom role (e.g.,{" "}
              <span className="font-mono">designer</span>).{" "}
              {roles.length > 0
                ? `Restricted to ${roles.length} role${roles.length !== 1 ? "s" : ""}.`
                : "Leave empty to allow every role."}
            </p>
          </div>

          {err && (
            <div className="flex items-start gap-2 text-xs text-red-300/90 glass-light rounded-md px-3 py-2">
              <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
              <span>{humanizeImportError(err)}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/8 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs text-white/80 hover:bg-white/8 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || source.trim() === ""}
            className="px-4 py-1.5 rounded-lg bg-white/15 hover:bg-white/20 text-xs text-white/95 font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}


function humanizeImportError(code: string): string {
  switch (code) {
    case "no_skill_md":
      return "Skill folder doesn't contain a SKILL.md file.";
    case "invalid_frontmatter":
      return "SKILL.md is missing required frontmatter (name).";
    case "invalid_source":
      return "Couldn't parse the source. Use owner/repo/slug or a GitHub tree URL.";
    case "github_not_found":
      return "GitHub returned 404 — check the path and visibility.";
    case "github_rate_limited":
      return "GitHub rate limit hit. Try again later or configure GITHUB_TOKEN on the server.";
    case "github_failed":
      return "GitHub request failed.";
    default:
      return `Import failed (${code}).`;
  }
}

// ── Skill card ───────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  onOpen,
  onDelete,
}: {
  skill: SkillDTO;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const shortSha = skill.sourceRef.slice(0, 7);
  const fileCount = skill.fileInventory.length;

  return (
    <button
      onClick={onOpen}
      className="group relative text-left glass-light rounded-xl p-4 hover:bg-white/6 transition-colors"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-white/90 truncate">
              {skill.name}
            </h3>
            {skill.companyId === null && (
              <span className="text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-300/90 border border-emerald-400/15 shrink-0">
                OCCA
              </span>
            )}
          </div>
          <p className="text-xs text-white/40 truncate font-mono mt-0.5">
            {skill.key}
          </p>
        </div>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 size-7 rounded-md hover:bg-red-500/15 text-white/40 hover:text-red-300 flex items-center justify-center cursor-pointer"
          aria-label="Delete skill"
        >
          <Trash2 className="size-3.5" />
        </span>
      </div>

      {skill.description && (
        <p className="text-xs text-white/60 line-clamp-2 mb-3">
          {skill.description}
        </p>
      )}

      <RoleBadges roles={skill.allowedRoles} />

      <div className="flex items-center gap-3 text-[11px] text-white/40 mt-2.5">
        <span className="flex items-center gap-1">
          <FileText className="size-3" />
          {fileCount} file{fileCount !== 1 ? "s" : ""}
        </span>
        <span className="font-mono">{shortSha}</span>
      </div>
    </button>
  );
}

function RoleBadges({ roles }: { roles: AgentRole[] }) {
  if (roles.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-white/40">
        <Users className="size-3" /> All roles
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <ShieldCheck className="size-3 text-amber-300/70 shrink-0" />
      {roles.map((r) => (
        <span
          key={r}
          className="text-[10px] uppercase tracking-wide font-medium rounded px-1.5 py-0.5 bg-amber-500/10 text-amber-200/90"
        >
          {r}
        </span>
      ))}
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────

export function SkillDetailModal({
  skill,
  onClose,
  onUpdateRoles,
  onDelete,
  onRefresh,
  extraRoles,
}: {
  skill: SkillDTO;
  onClose: () => void;
  onUpdateRoles?: (roles: AgentRole[]) => Promise<void>;
  onDelete?: () => void;
  onRefresh?: () => Promise<{ updated: boolean; skill: SkillDTO }>;
  extraRoles?: string[];
}) {
  const [editingRoles, setEditingRoles] = useState(false);
  const [refreshState, setRefreshState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "result"; updated: boolean; sourceRef: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const grouped = useMemo(() => groupByKind(skill.fileInventory), [skill]);
  const repoUrl = `https://github.com/${skill.sourceOwner}/${skill.sourceRepo}/tree/${skill.sourceRef}/${skill.sourcePath}`;

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshState({ kind: "checking" });
    try {
      const res = await onRefresh();
      setRefreshState({
        kind: "result",
        updated: res.updated,
        sourceRef: res.skill.sourceRef,
      });
    } catch (e) {
      const message =
        e instanceof ApiError
          ? ((e.body as { error?: string } | null)?.error ?? `http_${e.status}`)
          : "network_error";
      setRefreshState({ kind: "error", message });
    }
  }, [onRefresh]);

  return (
    <>
      <Modal open onClose={onClose} widthClassName="max-w-3xl">
        <div
          className="rounded-2xl overflow-hidden flex flex-col max-h-[80vh]"
          style={{
            background: "rgba(20, 20, 24, 0.92)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(255, 255, 255, 0.10)",
          }}
        >
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/8">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-white/90 truncate">
                {skill.name}
              </h3>
              <p className="text-xs text-white/50 font-mono truncate mt-0.5">
                {skill.key} · {skill.sourceRef.slice(0, 7)}
              </p>
            </div>
            <button
              onClick={onClose}
              className="size-7 rounded-md hover:bg-white/10 text-white/50 hover:text-white/90 flex items-center justify-center shrink-0"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {skill.description && (
              <div className="px-5 py-3 border-b border-white/6">
                <p className="text-sm text-white/70">{skill.description}</p>
              </div>
            )}

            <div className="px-5 py-4 border-b border-white/6 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="text-[11px] uppercase tracking-wide text-white/40 mb-2">
                  Allowed roles
                </h4>
                <RoleBadges roles={skill.allowedRoles} />
              </div>
              {onUpdateRoles && (
                <button
                  onClick={() => setEditingRoles(true)}
                  className="px-2.5 py-1 rounded-md bg-white/8 hover:bg-white/12 text-[11px] text-white/80 shrink-0"
                >
                  Edit roles
                </button>
              )}
            </div>

            <div className="px-5 py-4 border-b border-white/6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="text-[11px] uppercase tracking-wide text-white/40 mb-2">
                    Source
                  </h4>
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-300/90 hover:text-blue-200 font-mono break-all"
                  >
                    {repoUrl}
                  </a>
                </div>
                {onRefresh && (
                  <button
                    onClick={handleRefresh}
                    disabled={refreshState.kind === "checking"}
                    className="px-2.5 py-1 rounded-md bg-white/8 hover:bg-white/12 text-[11px] text-white/80 shrink-0 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {refreshState.kind === "checking" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    Check for update
                  </button>
                )}
              </div>
              {refreshState.kind === "result" && (
                <div
                  className={`mt-3 flex items-center gap-2 text-[11px] ${
                    refreshState.updated
                      ? "text-emerald-300/90"
                      : "text-white/55"
                  }`}
                >
                  <CheckCircle2 className="size-3" />
                  {refreshState.updated
                    ? `Updated to ${refreshState.sourceRef.slice(0, 7)}.`
                    : "Already up to date."}
                </div>
              )}
              {refreshState.kind === "error" && (
                <div className="mt-3 flex items-center gap-2 text-[11px] text-red-300/90">
                  <AlertCircle className="size-3" />
                  Refresh failed: {refreshState.message}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-b border-white/6">
              <h4 className="text-[11px] uppercase tracking-wide text-white/40 mb-2">
                SKILL.md
              </h4>
              <pre className="text-xs text-white/75 whitespace-pre-wrap font-mono glass-light rounded-lg p-3 max-h-72 overflow-y-auto">
                {skill.markdown}
              </pre>
            </div>

            <div className="px-5 py-4">
              <h4 className="text-[11px] uppercase tracking-wide text-white/40 mb-2">
                Files ({skill.fileInventory.length})
              </h4>
              {skill.fileInventory.length === 0 ? (
                <p className="text-xs text-white/40">No files in inventory.</p>
              ) : (
                <div className="space-y-3">
                  {(
                    [
                      ["markdown", "Markdown"],
                      ["script", "Scripts"],
                      ["reference", "References"],
                      ["asset", "Assets"],
                    ] as const
                  ).map(([kind, label]) =>
                    grouped[kind].length > 0 ? (
                      <div key={kind}>
                        <p className="text-[10px] uppercase tracking-wide text-white/30 mb-1">
                          {label}
                        </p>
                        <ul className="space-y-0.5">
                          {grouped[kind].map((f) => (
                            <li
                              key={f.path}
                              className="text-xs text-white/70 font-mono truncate"
                            >
                              {f.path}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="px-5 py-3 border-t border-white/8 flex items-center justify-between">
            {onDelete ? (
              <button
                onClick={onDelete}
                className="text-xs text-red-300/80 hover:text-red-300 flex items-center gap-1.5"
              >
                <Trash2 className="size-3.5" /> Remove from library
              </button>
            ) : (
              <span />
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-xs text-white/90"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {editingRoles && onUpdateRoles && (
        <EditRolesModal
          skill={skill}
          extraRoles={extraRoles}
          onCancel={() => setEditingRoles(false)}
          onSave={async (roles) => {
            await onUpdateRoles(roles);
            setEditingRoles(false);
          }}
        />
      )}
    </>
  );
}

function groupByKind(
  inv: SkillFileEntry[],
): Record<SkillFileEntry["kind"], SkillFileEntry[]> {
  const out: Record<SkillFileEntry["kind"], SkillFileEntry[]> = {
    markdown: [],
    script: [],
    reference: [],
    asset: [],
  };
  for (const f of inv) out[f.kind].push(f);
  return out;
}

// ── Edit roles modal ─────────────────────────────────────────────────────────

function EditRolesModal({
  skill,
  onCancel,
  onSave,
  extraRoles,
}: {
  skill: SkillDTO;
  onCancel: () => void;
  onSave: (roles: AgentRole[]) => Promise<void>;
  extraRoles?: string[];
}) {
  const [roles, setRoles] = useState<AgentRole[]>(() => [
    ...skill.allowedRoles,
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(roles);
    } catch (e) {
      setErr(e instanceof ApiError ? `http_${e.status}` : "network_error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? () => {} : onCancel} widthClassName="max-w-md">
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: "rgba(20, 20, 24, 0.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.10)",
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <h3 className="text-sm font-semibold text-white/90">
            Edit allowed roles
          </h3>
          <button
            onClick={onCancel}
            disabled={busy}
            className="size-7 rounded-md hover:bg-white/10 text-white/50 hover:text-white/90 flex items-center justify-center disabled:opacity-40"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-white/50">
            Restrict{" "}
            <span className="font-mono text-white/70">{skill.key}</span> to
            specific agent roles. Leave empty to allow every role.
          </p>
          <RoleMultiSelect
            value={roles}
            onChange={setRoles}
            disabled={busy}
            extraRoles={extraRoles}
          />
          {err && (
            <div className="flex items-center gap-2 text-xs text-red-300/80">
              <AlertCircle className="size-3.5" /> {err}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/8 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs text-white/80 hover:bg-white/8 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="px-4 py-1.5 rounded-lg bg-white/15 hover:bg-white/20 text-xs text-white/95 font-medium disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Confirm delete modal ─────────────────────────────────────────────────────

function ConfirmDeleteModal({
  skill,
  onCancel,
  onConfirm,
}: {
  skill: SkillDTO;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Modal open onClose={busy ? () => {} : onCancel} widthClassName="max-w-sm">
      <div
        className="rounded-2xl p-5 space-y-4"
        style={{
          background: "rgba(20, 20, 24, 0.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.10)",
        }}
      >
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-white/90">
            Remove this skill?
          </h3>
          <p className="text-xs text-white/60">
            <span className="font-mono">{skill.key}</span> will be removed from
            your library. Agents still referencing it will lose access on the
            next sync.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs text-white/80 hover:bg-white/8 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-red-500/80 hover:bg-red-500 text-xs text-white font-medium disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Remove
          </button>
        </div>
      </div>
    </Modal>
  );
}
