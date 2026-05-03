"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  FileText,
  Link2,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Modal } from "@/components/ui/modal";
import { useSkills } from "@/features/skills/api/use-skills";
import { ApiError } from "@/lib/api";
import {
  ROLE_SLUG_MAX,
  ROLE_SLUG_PATTERN,
  type AgentRole,
  type SkillDTO,
  type SkillFileEntry,
} from "@occa/shared/types";
import { AGENT_ROLES } from "@occa/shared/role-catalog";

interface SkillLibraryProps {
  onClose?: () => void;
  onReloadMe?: () => Promise<void> | void;
}

export function SkillLibrary({ onClose, onReloadMe }: SkillLibraryProps) {
  const { skills, loading, error, importSkill, updateRoles, remove } =
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
          onClose={() => setSelected(null)}
          onUpdateRoles={async (roles) => {
            const updated = await updateRoles(selected.id, roles);
            setSelected(updated);
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
}: {
  onCancel: () => void;
  onSubmit: (input: {
    source: string;
    allowedRoles: AgentRole[];
  }) => Promise<void>;
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

function normalizeRoleSlug(input: string): string {
  return input.trim().toLowerCase();
}

function isValidRoleSlug(input: string): boolean {
  if (input.length === 0 || input.length > ROLE_SLUG_MAX) return false;
  return ROLE_SLUG_PATTERN.test(input);
}

function RoleMultiSelect({
  value,
  onChange,
  disabled,
}: {
  value: AgentRole[];
  onChange: (next: AgentRole[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const update = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  const normalized = normalizeRoleSlug(query);

  const add = useCallback(
    (role: string) => {
      const slug = normalizeRoleSlug(role);
      if (!isValidRoleSlug(slug)) return;
      if (value.includes(slug)) return;
      onChange([...value, slug]);
      setQuery("");
    },
    [onChange, value],
  );

  const remove = useCallback(
    (role: string) => onChange(value.filter((r) => r !== role)),
    [onChange, value],
  );

  const suggestions = useMemo(() => {
    const pool = AGENT_ROLES.filter(
      (r) =>
        !value.includes(r) && (normalized === "" || r.includes(normalized)),
    );
    return pool;
  }, [normalized, value]);

  const canCreate =
    normalized.length > 0 &&
    isValidRoleSlug(normalized) &&
    !value.includes(normalized) &&
    !AGENT_ROLES.includes(normalized as (typeof AGENT_ROLES)[number]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) add(suggestions[0]);
      else if (canCreate) add(normalized);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={`flex flex-wrap items-center gap-1.5 glass-light rounded-lg px-2 py-1.5 min-h-9.5 ${
          disabled ? "opacity-50" : "cursor-text"
        }`}
      >
        {value.map((r) => (
          <span
            key={r}
            className="flex items-center gap-1 bg-white/12 rounded px-2 py-0.5 text-[11px] uppercase tracking-wide text-white/90"
          >
            {r}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(r);
              }}
              disabled={disabled}
              className="size-3 rounded-sm hover:bg-white/20 flex items-center justify-center -mr-0.5"
              aria-label={`Remove ${r}`}
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}
        {open && !disabled ? (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, ROLE_SLUG_MAX))}
            onKeyDown={onInputKeyDown}
            placeholder={
              value.length === 0 ? "Pick or type a role…" : "Add more…"
            }
            className="flex-1 min-w-20 bg-transparent text-xs text-white/90 placeholder:text-white/30 focus:outline-none"
          />
        ) : value.length === 0 ? (
          <span className="text-xs text-white/35 px-1 select-none">
            All roles — click to restrict
          </span>
        ) : null}
        {!open && !disabled && (
          <ChevronDown className="size-3.5 text-white/30 ml-auto" />
        )}
      </div>

      {open &&
        !disabled &&
        coords &&
        createPortal(
          <div
            ref={dropdownRef}
            className="rounded-lg py-1 max-h-56 overflow-y-auto"
            style={{
              position: "fixed",
              left: coords.left,
              top: coords.top,
              width: coords.width,
              zIndex: 300,
              background: "rgba(18, 18, 22, 0.96)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: "1px solid rgba(255, 255, 255, 0.10)",
            }}
          >
            {suggestions.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-[11px] text-white/40">
                {normalized === ""
                  ? "All presets already selected."
                  : "Invalid role — use lowercase letters, digits, _ or -."}
              </div>
            )}
            {suggestions.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => add(r)}
                className="w-full text-left px-3 py-1.5 text-xs text-white/85 hover:bg-white/8 flex items-center gap-2"
              >
                <span className="uppercase tracking-wide font-medium">{r}</span>
                <span className="text-[10px] text-white/30">preset</span>
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                onClick={() => add(normalized)}
                className="w-full text-left px-3 py-1.5 text-xs text-white/85 hover:bg-white/8 flex items-center gap-2 border-t border-white/6"
              >
                <Plus className="size-3 text-white/50" />
                Create{" "}
                <span className="uppercase tracking-wide font-medium">
                  {normalized}
                </span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
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
          <h3 className="text-sm font-semibold text-white/90 truncate">
            {skill.name}
          </h3>
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
}: {
  skill: SkillDTO;
  onClose: () => void;
  onUpdateRoles?: (roles: AgentRole[]) => Promise<void>;
  onDelete?: () => void;
}) {
  const [editingRoles, setEditingRoles] = useState(false);
  const grouped = useMemo(() => groupByKind(skill.fileInventory), [skill]);
  const repoUrl = `https://github.com/${skill.sourceOwner}/${skill.sourceRepo}/tree/${skill.sourceRef}/${skill.sourcePath}`;

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
}: {
  skill: SkillDTO;
  onCancel: () => void;
  onSave: (roles: AgentRole[]) => Promise<void>;
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
          <RoleMultiSelect value={roles} onChange={setRoles} disabled={busy} />
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
