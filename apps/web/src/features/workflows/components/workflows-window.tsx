"use client";

// Settings → Workflows. Per-company list of YAML auto-follow-up rules
// driven by /api/workflows. Layout mirrors RoutinesWindow: sidebar
// list + detail pane. The detail pane is a plain YAML textarea
// (Monaco / CodeMirror is overkill for foundation); validation errors
// are echoed inline so users see the line/column or Zod issue without
// leaving the editor.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Code, Loader2, Plus, Trash2 } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type { WorkflowDTO } from "@occa/shared/types";
import { parseWorkflowYaml } from "@occa/shared/workflows";
import { ApiError } from "@/lib/api";
import { useWorkflows } from "../api/use-workflows";
import type { WorkflowTemplate } from "../templates";
import { TemplateGallery } from "./template-gallery";
import {
  WorkflowFormEditor,
  formStateFromDefinition,
  formStateToYaml,
  type WorkflowFormState,
} from "./workflow-form-editor";
import { WorkflowPreviewPane } from "./workflow-preview-pane";

interface WorkflowsWindowProps {
  onClose?: () => void;
}

// "Create" is a two-stage flow: pick a template, then edit the prefilled
// YAML. The stage lives in component state rather than the URL because
// the modal is a transient window, not a navigable surface.
type CreateStage = "gallery" | "editor";

export function WorkflowsWindow({ onClose }: WorkflowsWindowProps) {
  const { workflows, loading, error, create, patch, remove } = useWorkflows(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStage, setCreateStage] = useState<CreateStage>("gallery");
  const [pickedTemplate, setPickedTemplate] =
    useState<WorkflowTemplate | null>(null);
  const [createTriggerRect, setCreateTriggerRect] =
    useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selectedId && workflows.length > 0 && !creating) {
      setSelectedId(workflows[0].id);
    }
  }, [workflows, selectedId, creating]);

  const closeCreate = () => {
    setCreating(false);
    setPickedTemplate(null);
    setCreateTriggerRect(null);
  };

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  return (
    <AppWindow
      title="Workflows"
      subtitle={`${workflows.length} workflow${workflows.length !== 1 ? "s" : ""}`}
      onClose={onClose}
      defaultSize={{
        w: Math.min(1100, Math.round(window.innerWidth * 0.85)),
        h: Math.min(720, Math.round(window.innerHeight * 0.85)),
      }}
      minWidth={760}
      minHeight={460}
    >
      <div className="flex h-full overflow-hidden">
        <WorkflowSidebar
          workflows={workflows}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          onCreate={(rect) => {
            setCreating(true);
            setCreateStage("gallery");
            setPickedTemplate(null);
            setCreateTriggerRect(rect);
          }}
          loading={loading}
        />
        <div className="flex-1 min-w-0 overflow-y-auto">
          {error && (
            <div className="px-5 pt-4">
              <div className="flex items-center gap-2 text-xs text-red-300/80">
                <AlertCircle className="size-3.5" /> {error}
              </div>
            </div>
          )}
          {selected ? (
            <WorkflowDetail
              key={selected.id}
              workflow={selected}
              onPatch={(input) => patch(selected.id, input)}
              onRemove={async () => {
                const ok = await remove(selected.id);
                if (ok) setSelectedId(null);
              }}
            />
          ) : workflows.length === 0 && !loading ? (
            <div className="p-8 text-center space-y-2">
              <p className="text-sm text-white/50">No workflows yet</p>
              <p className="text-xs text-white/35">
                Click <span className="text-white/60">+ New</span> to spawn
                follow-up tasks automatically when a parent completes.
              </p>
            </div>
          ) : (
            <div className="p-8 flex items-center justify-center text-xs text-white/40">
              {loading && <Loader2 className="size-3.5 animate-spin mr-2" />}
              Select a workflow
            </div>
          )}
        </div>
      </div>
      {creating && createStage === "gallery" && (
        <FloatingPanel
          title="New workflow"
          subtitle="Pick a starting point — every field is editable next."
          width={560}
          triggerRect={createTriggerRect}
          backdrop="block"
          onClose={closeCreate}
        >
          <TemplateGallery
            onPick={(tpl) => {
              setPickedTemplate(tpl);
              setCreateStage("editor");
            }}
            onCancel={closeCreate}
          />
        </FloatingPanel>
      )}
      {creating && createStage === "editor" && pickedTemplate && (
        <FloatingPanel
          title="New workflow"
          subtitle={`From template: ${pickedTemplate.label}`}
          width={Math.min(900, Math.round(window.innerWidth * 0.9))}
          height={Math.min(720, Math.round(window.innerHeight * 0.85))}
          triggerRect={createTriggerRect}
          backdrop="block"
          onClose={closeCreate}
        >
          <WorkflowCreateForm
            initialYaml={pickedTemplate.yamlText}
            templateLabel={pickedTemplate.label}
            onBack={() => setCreateStage("gallery")}
            onCancel={closeCreate}
            onCreate={async (input) => {
              const row = await create(input);
              if (row) {
                closeCreate();
                setSelectedId(row.id);
              }
              return row;
            }}
          />
        </FloatingPanel>
      )}
    </AppWindow>
  );
}

function WorkflowSidebar({
  workflows,
  selectedId,
  onSelect,
  onCreate,
  loading,
}: {
  workflows: WorkflowDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (triggerRect: DOMRect) => void;
  loading: boolean;
}) {
  const newBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="w-64 shrink-0 flex flex-col border-r border-white/8">
      <div className="px-3 py-3 border-b border-white/8 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Workflows
        </div>
        <Button
          ref={newBtnRef}
          size="sm"
          variant="secondary"
          onClick={() => {
            const rect = newBtnRef.current?.getBoundingClientRect();
            if (rect) onCreate(rect);
          }}
        >
          <Plus className="size-3" /> New
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && workflows.length === 0 && (
          <div className="p-4 flex items-center gap-2 text-xs text-white/40">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {workflows.map((w) => {
          const active = w.id === selectedId;
          return (
            <button
              key={w.id}
              onClick={() => onSelect(w.id)}
              className={`relative w-full text-left flex flex-col gap-0.5 px-3 py-2 border-b border-white/6 transition-colors ${
                active ? "bg-white/8" : "hover:bg-white/4"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-white/80" />
              )}
              <div className="text-xs font-medium text-white/90 truncate">
                {w.name}
              </div>
              <div className="text-[10px] text-white/40 font-mono truncate">
                {w.yamlId}
              </div>
              {!w.enabled && (
                <span className="text-[10px] uppercase text-amber-200/80">
                  disabled
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface YamlInvalidDetail {
  kind?: "schema" | "yaml_syntax";
  message?: string;
  line?: number;
  col?: number;
  issues?: Array<{ path?: (string | number)[]; message?: string }>;
}

function extractYamlError(err: unknown): {
  code: string;
  detail?: YamlInvalidDetail;
  conflictId?: string;
} {
  if (err instanceof ApiError) {
    const body = err.body as
      | {
          error?: string;
          detail?: YamlInvalidDetail;
          yamlId?: string;
        }
      | null
      | undefined;
    return {
      code: body?.error ?? `api_${err.status}`,
      detail: body?.detail,
      conflictId: body?.yamlId,
    };
  }
  return { code: "network_error" };
}

function YamlErrorBanner({
  code,
  detail,
  conflictId,
}: {
  code: string;
  detail?: YamlInvalidDetail;
  conflictId?: string;
}) {
  if (code === "workflow_id_conflict") {
    return (
      <div className="flex items-start gap-2 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
        <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
        <div>
          A workflow with id <code className="font-mono">{conflictId}</code> already exists. Pick another <code className="font-mono">id:</code>.
        </div>
      </div>
    );
  }
  if (code === "workflow_yaml_invalid") {
    if (detail?.kind === "yaml_syntax") {
      return (
        <div className="flex items-start gap-2 text-xs text-red-300/90 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="font-medium">YAML syntax error</div>
            <div className="font-mono text-[11px] text-red-200/80">
              {detail.message ?? "(no detail)"}
            </div>
            {detail.line != null && (
              <div className="text-[10px] text-red-200/60">
                line {detail.line}
                {detail.col != null && `, col ${detail.col}`}
              </div>
            )}
          </div>
        </div>
      );
    }
    if (detail?.kind === "schema" && detail.issues?.length) {
      return (
        <div className="flex items-start gap-2 text-xs text-red-300/90 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="font-medium">Workflow definition invalid</div>
            <ul className="space-y-0.5 font-mono text-[11px] text-red-200/80">
              {detail.issues.slice(0, 6).map((issue, i) => (
                <li key={i}>
                  {(issue.path ?? []).join(".") || "(root)"}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs text-red-300/80">
      <AlertCircle className="size-3.5" /> {code}
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function WorkflowDetail({
  workflow,
  onPatch,
  onRemove,
}: {
  workflow: WorkflowDTO;
  onPatch: (input: {
    yamlText?: string;
    enabled?: boolean;
  }) => Promise<WorkflowDTO | null>;
  onRemove: () => Promise<void>;
}) {
  // Try to render existing workflows in the form editor; fall back to
  // YAML for unparseable rows.
  const initialFormState = useMemo(
    () => tryParseFormState(workflow.yamlText),
    [workflow.yamlText],
  );
  const [mode, setMode] = useState<"form" | "yaml">(
    initialFormState ? "form" : "yaml",
  );
  const [formState, setFormState] = useState<WorkflowFormState | null>(
    initialFormState,
  );
  const [yamlText, setYamlText] = useState(workflow.yamlText);
  const [saving, setSaving] = useState(false);
  // Enable/disable is applied immediately (independent of the YAML save), so it
  // only needs an in-flight flag, not draft state.
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [yamlError, setYamlError] = useState<{
    code: string;
    detail?: YamlInvalidDetail;
    conflictId?: string;
  } | null>(null);

  // Reset local edit state only when the user switches to a DIFFERENT
  // workflow — keyed on id, not on every field change of the same row, so an
  // immediate enable/disable toggle (or a post-save refetch) never wipes an
  // in-progress YAML edit.
  useEffect(() => {
    const next = tryParseFormState(workflow.yamlText);
    setFormState(next);
    setMode(next ? "form" : "yaml");
    setYamlText(workflow.yamlText);
    setYamlError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id]);

  // Auto-clear the "Saved" indicator after a short window so it doesn't
  // linger past the moment the user actually cares about it.
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  // The current "draft" YAML the user is editing — derived from
  // whichever surface they're using. Used for the dirty check + patch
  // payload so a form edit and a raw-YAML edit both go through the same
  // path.
  const draftYaml =
    mode === "form" && formState
      ? formStateToYaml(formState)
      : yamlText;
  // Compare by parsed structure (when both sides parse cleanly) to
  // ignore trailing newlines / quoting drift introduced by the YAML lib
  // round-trip; fall back to trimmed text compare when a side is
  // unparseable so the user can still save raw YAML edits.
  const draftParsed = parseWorkflowYaml(draftYaml);
  const currentParsed = parseWorkflowYaml(workflow.yamlText);
  const yamlDirty = (() => {
    if (draftParsed.ok && currentParsed.ok) {
      return (
        JSON.stringify(draftParsed.value.definition) !==
        JSON.stringify(currentParsed.value.definition)
      );
    }
    return draftYaml.trim() !== workflow.yamlText.trim();
  })();
  const dirty = yamlDirty;

  // Live client-side validation of the current draft. Surfaces *why* the
  // definition won't parse (e.g. an unknown step kind) right away — instead of
  // silently dropping to the raw-YAML editor with no explanation — and blocks
  // Save on an invalid YAML edit before it round-trips to the server. A purely
  // enable/disable toggle (YAML untouched) is still allowed even if the stored
  // YAML is stale.
  const draftValid = draftParsed.ok;
  const blockInvalidSave = yamlDirty && !draftValid;
  const displayError: {
    code: string;
    detail?: YamlInvalidDetail;
    conflictId?: string;
  } | null =
    yamlError ??
    (!draftParsed.ok
      ? {
          code: "workflow_yaml_invalid",
          detail:
            draftParsed.error.kind === "yaml_syntax"
              ? {
                  kind: "yaml_syntax",
                  message: draftParsed.error.message,
                  line: draftParsed.error.line,
                  col: draftParsed.error.col,
                }
              : { kind: "schema", issues: draftParsed.error.issues },
        }
      : null);

  const handleSave = async () => {
    setSaving(true);
    setYamlError(null);
    try {
      await onPatch({ yamlText: draftYaml });
      setSavedAt(Date.now());
    } catch (err) {
      setYamlError(extractYamlError(err));
    } finally {
      setSaving(false);
    }
  };

  // Enable/disable is an immediate action, not part of the YAML draft — it
  // flips the saved state straight away so it never gets stuck behind an
  // unsaved (or invalid) YAML edit.
  const toggleEnabled = async () => {
    setTogglingEnabled(true);
    try {
      await onPatch({ enabled: !workflow.enabled });
    } catch (err) {
      setYamlError(extractYamlError(err));
    } finally {
      setTogglingEnabled(false);
    }
  };

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold text-white/90 truncate">
              {workflow.name}
            </div>
            {/* Status — separate from the action button so state is unambiguous. */}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                workflow.enabled
                  ? "bg-emerald-500/12 text-emerald-300/90"
                  : "bg-white/8 text-white/45"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  workflow.enabled ? "bg-emerald-400" : "bg-white/35"
                }`}
              />
              {workflow.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="text-[11px] text-white/40 font-mono truncate">
            {workflow.yamlId}
          </div>
          <div className="text-[10px] text-white/35">
            Created {formatWhen(workflow.createdAt)} · Updated{" "}
            {formatWhen(workflow.updatedAt)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Action — labelled by what the click DOES, not the current state. */}
          <Button
            size="sm"
            variant={workflow.enabled ? "secondary" : "success"}
            onClick={toggleEnabled}
            disabled={togglingEnabled}
          >
            {togglingEnabled
              ? "…"
              : workflow.enabled
                ? "Disable"
                : "Enable"}
          </Button>
          <Button size="sm" variant="danger" onClick={onRemove}>
            <Trash2 className="size-3" /> Delete
          </Button>
        </div>
      </div>

      {workflow.description && (
        <div className="text-xs text-white/60 italic">
          {workflow.description}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Definition
          </div>
          {formState && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                if (mode === "form" && formState) {
                  setYamlText(formStateToYaml(formState));
                  setMode("yaml");
                } else {
                  const reparsed = tryParseFormState(yamlText);
                  if (reparsed) {
                    setFormState(reparsed);
                    setMode("form");
                  }
                }
              }}
            >
              <Code className="size-3" />
              {mode === "form" ? "Edit raw YAML" : "Back to form"}
            </Button>
          )}
        </div>
        {mode === "form" && formState ? (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px] gap-4">
            <WorkflowFormEditor
              state={formState}
              onChange={setFormState}
              lockYamlId
            />
            <aside className="lg:border-l lg:border-white/8 lg:pl-4">
              <WorkflowPreviewPane state={formState} />
            </aside>
          </div>
        ) : (
          <textarea
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            spellCheck={false}
            rows={20}
            className="w-full bg-black/30 rounded px-3 py-2 text-xs font-mono leading-relaxed text-white/85 outline-none border border-white/8 focus:border-white/20 resize-y min-h-40"
          />
        )}
      </div>

      {displayError && (
        <YamlErrorBanner
          code={displayError.code}
          detail={displayError.detail}
          conflictId={displayError.conflictId}
        />
      )}

      <div className="flex items-center justify-end gap-2">
        {savedAt !== null && !saving && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300/85 transition-opacity">
            <Check className="size-3" />
            Saved
          </span>
        )}
        {dirty && !saving && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const reparsed = tryParseFormState(workflow.yamlText);
              setFormState(reparsed);
              setMode(reparsed ? "form" : "yaml");
              setYamlText(workflow.yamlText);
              setYamlError(null);
            }}
          >
            Discard
          </Button>
        )}
        <Button
          size="sm"
          variant="success"
          onClick={handleSave}
          disabled={!dirty || saving || blockInvalidSave}
          title={
            blockInvalidSave ? "Fix the definition errors before saving" : undefined
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function WorkflowCreateForm({
  initialYaml,
  templateLabel,
  onBack,
  onCancel,
  onCreate,
}: {
  initialYaml: string;
  templateLabel: string | null;
  onBack: () => void;
  onCancel: () => void;
  onCreate: (input: {
    yamlText: string;
    enabled?: boolean;
  }) => Promise<WorkflowDTO | null>;
}) {
  // Templates open in the form editor; unparseable YAML falls back to
  // the raw textarea. The user can also flip to YAML view at any time
  // via "Edit raw YAML" if they prefer.
  const initialFormState = tryParseFormState(initialYaml);
  const [mode, setMode] = useState<"form" | "yaml">(
    initialFormState ? "form" : "yaml",
  );
  const [formState, setFormState] = useState<WorkflowFormState | null>(
    initialFormState,
  );
  const [yamlText, setYamlText] = useState(initialYaml);
  const [submitting, setSubmitting] = useState(false);
  const [yamlError, setYamlError] = useState<{
    code: string;
    detail?: YamlInvalidDetail;
    conflictId?: string;
  } | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setYamlError(null);
    try {
      const payload =
        mode === "form" && formState
          ? { yamlText: formStateToYaml(formState) }
          : { yamlText };
      await onCreate(payload);
    } catch (err) {
      setYamlError(extractYamlError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // _templateLabel only used in the panel header now; kept for caller
  // compat but unused here. Mark to silence lint.
  void templateLabel;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-5 pt-3 pb-2 border-b border-white/8">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Back to templates
        </Button>
        {formState && mode === "form" && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setYamlText(formStateToYaml(formState));
              setMode("yaml");
            }}
          >
            <Code className="size-3" /> Edit raw YAML
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === "form" && formState ? (
          <div className="h-full grid grid-cols-[minmax(0,1fr)_280px] gap-4 px-5 py-4 overflow-hidden">
            <div className="overflow-y-auto pr-1 space-y-3">
              <WorkflowFormEditor state={formState} onChange={setFormState} />
              {yamlError && (
                <YamlErrorBanner
                  code={yamlError.code}
                  detail={yamlError.detail}
                  conflictId={yamlError.conflictId}
                />
              )}
            </div>
            <aside className="border-l border-white/8 pl-4 overflow-y-auto">
              <WorkflowPreviewPane state={formState} />
            </aside>
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-5 py-4 space-y-3">
            <textarea
              value={yamlText}
              onChange={(e) => setYamlText(e.target.value)}
              spellCheck={false}
              rows={22}
              className="w-full bg-black/30 rounded px-3 py-2 text-xs font-mono leading-relaxed text-white/85 outline-none border border-white/8 focus:border-white/20 resize-y min-h-40"
            />
            {yamlError && (
              <YamlErrorBanner
                code={yamlError.code}
                detail={yamlError.detail}
                conflictId={yamlError.conflictId}
              />
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/8 shrink-0">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="success"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}

// Best-effort YAML → form-state. Returns null when the YAML can't be
// parsed; caller falls back to the raw textarea so a malformed row
// doesn't strand the user.
function tryParseFormState(yamlText: string): WorkflowFormState | null {
  const parsed = parseWorkflowYaml(yamlText);
  if (!parsed.ok) return null;
  return formStateFromDefinition(parsed.value.definition);
}
