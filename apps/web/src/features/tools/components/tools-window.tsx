"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import type {
  CompanyToolDTO,
  ToolCatalogEntry,
  ToolTestConnectionResult,
} from "@occa/shared/types";
import { AppWindow } from "@/components/ui/app-window";
import { Modal } from "@/components/ui/modal";
import { useCompanyTools, useToolCatalog } from "@/features/tools/api/use-tools";
import { AddToolModal } from "./add-tool-modal";
import { EditToolModal } from "./edit-tool-modal";
import { ToolLogs } from "./tool-logs";
import { ToolConnection } from "./tool-connection";

interface ToolsWindowProps {
  companyId: string;
  companyName: string;
  onClose?: () => void;
  // Custom roles already in use by deployments in this company, surfaced
  // as suggestions in the install / edit role picker. Mirrors SkillLibrary
  // so operators don't have to retype slugs like `social_media_editor`.
  extraRoles?: string[];
}

export function ToolsWindow({ companyId, companyName, onClose, extraRoles }: ToolsWindowProps) {
  const { tools, loading, error, install, patch, remove, test } =
    useCompanyTools(companyId, true);
  const { tools: catalog } = useToolCatalog(true);

  const catalogByType = useMemo(() => {
    const map = new Map<string, ToolCatalogEntry>();
    for (const entry of catalog) map.set(entry.type, entry);
    return map;
  }, [catalog]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CompanyToolDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CompanyToolDTO | null>(null);
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "result"; result: ToolTestConnectionResult }
  >({ kind: "idle" });

  const selected = useMemo(
    () => tools.find((t) => t.id === selectedId) ?? tools[0] ?? null,
    [tools, selectedId],
  );

  // Reset transient state when selection changes
  useEffect(() => {
    setTestState({ kind: "idle" });
  }, [selected?.id]);

  const handleTest = useCallback(async () => {
    if (!selected) return;
    setTestState({ kind: "running" });
    try {
      const result = await test(selected.id);
      setTestState({ kind: "result", result });
    } catch (err) {
      setTestState({
        kind: "result",
        result: {
          ok: false,
          errorCode: "client_error",
          errorMessage: err instanceof Error ? err.message : "test failed",
        },
      });
    }
  }, [selected, test]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    await remove(pendingDelete.id);
    setPendingDelete(null);
    if (selectedId === pendingDelete.id) setSelectedId(null);
  }, [pendingDelete, remove, selectedId]);

  const headerRight = (
    <button
      onClick={() => setAddOpen(true)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white/90 font-medium transition-colors cursor-pointer"
    >
      <Plus className="size-3.5" /> Add Tool
    </button>
  );

  const subtitle = `${companyName} · ${tools.length} tool${tools.length !== 1 ? "s" : ""}`;

  return (
    <>
      <AppWindow
        title="Tools"
        subtitle={subtitle}
        onClose={onClose}
        headerRight={headerRight}
        defaultSize={{
          w: Math.min(1040, Math.round(window.innerWidth * 0.82)),
          h: Math.min(760, Math.round(window.innerHeight * 0.84)),
        }}
      >
        <div className="flex h-full overflow-hidden">
          {/* Sidebar list */}
          <div className="w-64 shrink-0 flex flex-col border-r border-white/8">
            {loading ? (
              <div className="flex items-center justify-center h-32 text-white/40 text-xs gap-2">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-32 text-red-300/80 text-xs gap-2 px-3 text-center">
                <AlertCircle className="size-3.5" /> {error}
              </div>
            ) : tools.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-white/40 text-xs px-4 text-center gap-3">
                <Plug className="size-6 text-white/20" />
                <p>No tools installed yet.</p>
                <button
                  onClick={() => setAddOpen(true)}
                  className="text-white/70 hover:text-white text-xs underline underline-offset-2 cursor-pointer"
                >
                  Install your first tool
                </button>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto py-1">
                {tools.map((tool) => {
                  const active = tool.id === (selected?.id ?? null);
                  return (
                    <button
                      key={tool.id}
                      onClick={() => setSelectedId(tool.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors relative cursor-pointer ${
                        active ? "bg-white/8" : "hover:bg-white/4"
                      }`}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-7 rounded-full bg-white/70" />
                      )}
                      <StatusDot status={tool.status} />
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-[12px] truncate ${active ? "text-white/95" : "text-white/80"}`}
                        >
                          {tool.label}
                        </p>
                        <p className="text-[10px] text-white/40 truncate">
                          {tool.displayName}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Detail */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {selected ? (
              <DetailPane
                tool={selected}
                catalog={catalogByType.get(selected.type)}
                onEdit={() => setEditTarget(selected)}
                onDelete={() => setPendingDelete(selected)}
                onTest={handleTest}
                onTogglePause={async () => {
                  await patch(selected.id, {
                    status: selected.status === "paused" ? "active" : "paused",
                  });
                }}
                testState={testState}
                companyId={companyId}
              />
            ) : !loading && tools.length > 0 ? (
              <div className="flex items-center justify-center h-full text-white/40 text-sm">
                Select a tool to view details
              </div>
            ) : null}
          </div>
        </div>
      </AppWindow>

      {addOpen && (
        <AddToolModal
          catalog={catalog}
          extraRoles={extraRoles}
          onCancel={() => setAddOpen(false)}
          onSubmit={async (input) => {
            const res = await install(input);
            setAddOpen(false);
            setSelectedId(res.tool.id);
            if (res.testConnection) {
              setTestState({ kind: "result", result: res.testConnection });
            }
          }}
        />
      )}

      {editTarget && (
        <EditToolModal
          tool={editTarget}
          catalog={catalogByType.get(editTarget.type)}
          extraRoles={extraRoles}
          onCancel={() => setEditTarget(null)}
          onSubmit={async (input) => {
            await patch(editTarget.id, input);
            setEditTarget(null);
          }}
        />
      )}

      {pendingDelete && (
        <Modal
          open
          title="Delete tool?"
          onClose={() => setPendingDelete(null)}
          width="min(420px, 92vw)"
        >
          <div className="px-5 py-5 space-y-4 text-sm text-white/80">
            <p>
              Removes <strong>{pendingDelete.label}</strong> (
              {pendingDelete.displayName}) and uninstalls the associated skill
              from every agent in this company.
            </p>
            <p className="text-white/55 text-xs">
              Credentials are wiped from the vault. Agents will lose access on
              the next skill-sync tick.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 rounded text-xs text-white/60 hover:text-white/90 hover:bg-white/5 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded text-xs bg-red-500/20 hover:bg-red-500/30 text-red-200 transition-colors cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function StatusDot({ status }: { status: CompanyToolDTO["status"] }) {
  const cls =
    status === "active"
      ? "bg-emerald-400"
      : status === "paused"
        ? "bg-amber-400"
        : "bg-red-400";
  return <span className={`size-1.5 rounded-full shrink-0 ${cls}`} />;
}

interface DetailPaneProps {
  tool: CompanyToolDTO;
  catalog: ToolCatalogEntry | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onTogglePause: () => Promise<void>;
  testState:
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "result"; result: ToolTestConnectionResult };
  companyId: string;
}

function DetailPane({
  tool,
  catalog,
  onEdit,
  onDelete,
  onTest,
  onTogglePause,
  testState,
  companyId,
}: DetailPaneProps) {
  const isPaused = tool.status === "paused";

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-white/8">
        <div className="flex items-start gap-3">
          <div className="size-8 rounded-lg bg-white/8 flex items-center justify-center shrink-0">
            <Wrench className="size-4 text-white/60" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-medium text-white/95 truncate">
                {tool.label}
              </h2>
              <span className="text-[11px] text-white/40">
                {tool.displayName}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-white/45">
              <span className="capitalize">{tool.status}</span>
              <span>·</span>
              <span>{tool.type}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {catalog?.hasTestConnection && (
              <button
                onClick={onTest}
                disabled={testState.kind === "running"}
                className="px-2 py-1 rounded text-[11px] text-white/60 hover:text-white hover:bg-white/8 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {testState.kind === "running" ? (
                  <>
                    <Loader2 className="size-3 animate-spin" /> Testing
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-3" /> Test
                  </>
                )}
              </button>
            )}
            <button
              onClick={onTogglePause}
              className="px-2 py-1 rounded text-[11px] text-white/60 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
            >
              {isPaused ? "Activate" : "Pause"}
            </button>
            <button
              onClick={onEdit}
              className="p-1 rounded text-white/60 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
              aria-label="Edit"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1 rounded text-red-300/80 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer"
              aria-label="Delete"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>

        {testState.kind === "result" && (
          <div
            className={`mt-3 px-3 py-2 rounded-md text-xs flex items-start gap-2 ${
              testState.result.ok
                ? "bg-emerald-500/10 text-emerald-200"
                : "bg-amber-500/10 text-amber-200"
            }`}
          >
            {testState.result.ok ? (
              <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="size-3.5 shrink-0 mt-0.5" />
            )}
            <span>
              {testState.result.ok
                ? (testState.result.detail ?? "Connection ok.")
                : `${testState.result.errorCode}: ${testState.result.errorMessage}`}
            </span>
          </div>
        )}

        {tool.lastError && (
          <div className="mt-3 px-3 py-2 rounded-md text-xs flex items-start gap-2 bg-red-500/10 text-red-200">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <span>{tool.lastError}</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {catalog && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
              About
            </h3>
            <p className="text-[12px] text-white/70 leading-relaxed">
              {catalog.description}
            </p>
          </section>
        )}

        <section>
          <h3 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
            Allowed roles
          </h3>
          {tool.allowedRoles && tool.allowedRoles.length > 0 ? (
            <div className="inline-flex items-center gap-1 flex-wrap">
              <ShieldCheck className="size-3 text-amber-300/70" />
              {tool.allowedRoles.map((r) => (
                <span
                  key={r}
                  className="text-[10px] uppercase tracking-wide font-medium rounded px-1.5 py-0.5 bg-amber-500/10 text-amber-200/90"
                >
                  {r}
                </span>
              ))}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-white/40">
              <Users className="size-3" /> All roles
            </span>
          )}
        </section>

        {catalog && catalog.credentialFields.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
              Connection
            </h3>
            <ToolConnection
              companyId={companyId}
              toolId={tool.id}
              fields={catalog.credentialFields}
            />
          </section>
        )}

        {catalog && catalog.actions.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
              Available actions
            </h3>
            <ul className="space-y-1.5">
              {catalog.actions.map((action) => (
                <li
                  key={action.name}
                  className="rounded-md bg-white/4 px-3 py-2"
                >
                  <p className="text-[12px] font-mono text-white/85">
                    {action.name}
                  </p>
                  <p className="text-[11px] text-white/55 mt-0.5">
                    {action.description}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
            Recent activity
          </h3>
          <ToolLogs companyId={companyId} toolId={tool.id} />
        </section>
      </div>
    </div>
  );
}
