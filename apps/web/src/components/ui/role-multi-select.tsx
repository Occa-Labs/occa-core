"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, X } from "lucide-react";
import {
  ROLE_SLUG_MAX,
  ROLE_SLUG_PATTERN,
  type AgentRole,
} from "@occa/shared/types";
import { AGENT_ROLES, roleLabelFor } from "@occa/shared/role-catalog";

// Slug form for storage / creation: lowercase, trimmed, and spaces folded to
// underscores so a role typed with spaces ("head editorial") still becomes a
// valid slug ("head_editorial").
function normalizeRoleSlug(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "_");
}

// Loose key for matching: lowercase with spaces, underscores, and hyphens all
// flattened to a single space, so a query typed any of those ways hits the
// same role regardless of separator.
function searchKey(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, " ").trim();
}

// A role matches when the query is a substring of EITHER its slug (id) or its
// human label (name) — both flattened so separators don't matter. Lets the
// user search "head editorial", "head_editorial", or "Head of Editorial".
function roleMatches(slug: string, query: string): boolean {
  const q = searchKey(query);
  if (q === "") return true;
  return (
    searchKey(slug).includes(q) ||
    searchKey(roleLabelFor(slug as AgentRole)).includes(q)
  );
}

function isValidRoleSlug(input: string): boolean {
  if (input.length === 0 || input.length > ROLE_SLUG_MAX) return false;
  return ROLE_SLUG_PATTERN.test(input);
}

export function RoleMultiSelect({
  value,
  onChange,
  disabled,
  emptyLabel = "All roles — click to restrict",
  extraRoles,
}: {
  value: AgentRole[];
  onChange: (next: AgentRole[]) => void;
  disabled?: boolean;
  emptyLabel?: string;
  // Custom roles already in use by deployments in this company. Merged
  // with the static AGENT_ROLES catalog so operators see roles they
  // actually deployed (e.g. `social_media_editor`) without having to
  // remember the slug and type it from scratch.
  extraRoles?: string[];
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

  const customRoles = useMemo(() => {
    if (!extraRoles) return [] as string[];
    const presets = new Set<string>(AGENT_ROLES);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of extraRoles) {
      const slug = normalizeRoleSlug(r);
      if (!isValidRoleSlug(slug)) continue;
      if (presets.has(slug)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
    return out;
  }, [extraRoles]);

  const suggestions = useMemo(() => {
    const presetPool = AGENT_ROLES.filter(
      (r) => !value.includes(r) && roleMatches(r, query),
    );
    const customPool = customRoles.filter(
      (r) => !value.includes(r) && roleMatches(r, query),
    );
    return { presetPool, customPool };
  }, [query, value, customRoles]);

  const canCreate =
    normalized.length > 0 &&
    isValidRoleSlug(normalized) &&
    !value.includes(normalized) &&
    !AGENT_ROLES.includes(normalized as (typeof AGENT_ROLES)[number]) &&
    !customRoles.includes(normalized);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first =
        suggestions.presetPool[0] ?? suggestions.customPool[0] ?? null;
      if (first) add(first);
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
            title={r}
            className="flex items-center gap-1 bg-white/12 rounded px-2 py-0.5 text-[11px] text-white/90"
          >
            {roleLabelFor(r as AgentRole)}
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
            {emptyLabel}
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
            {suggestions.presetPool.length === 0 &&
              suggestions.customPool.length === 0 &&
              !canCreate && (
                <div className="px-3 py-2 text-[11px] text-white/40">
                  {normalized === ""
                    ? "All known roles already selected."
                    : "Invalid role — use lowercase letters, digits, _ or -."}
                </div>
              )}
            {suggestions.presetPool.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => add(r)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/8 flex items-center gap-2"
              >
                <span className="font-medium text-white/90">
                  {roleLabelFor(r as AgentRole)}
                </span>
                <span className="text-[10px] font-mono text-white/35">{r}</span>
                <span className="text-[10px] text-white/30 ml-auto">preset</span>
              </button>
            ))}
            {suggestions.customPool.length > 0 && (
              <>
                {suggestions.presetPool.length > 0 && (
                  <div className="border-t border-white/6" />
                )}
                {suggestions.customPool.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => add(r)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/8 flex items-center gap-2"
                  >
                    <span className="font-medium text-white/90">
                      {roleLabelFor(r as AgentRole)}
                    </span>
                    <span className="text-[10px] font-mono text-white/35">
                      {r}
                    </span>
                    <span className="text-[10px] text-emerald-300/60 ml-auto">
                      in use
                    </span>
                  </button>
                ))}
              </>
            )}
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
