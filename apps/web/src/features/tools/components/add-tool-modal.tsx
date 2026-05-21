"use client";

import { useMemo, useState } from "react";
import { AlertCircle, ChevronLeft, Loader2, Plug } from "lucide-react";
import type {
  AgentRole,
  InstallCompanyToolRequest,
  ToolCatalogEntry,
  ToolCredentialField,
} from "@occa/shared/types";

type ToolFieldHint = ToolCredentialField;
import { Modal } from "@/components/ui/modal";
import { RoleMultiSelect } from "@/components/ui/role-multi-select";
import { CredentialFieldsForm } from "./credential-fields-form";

interface AddToolModalProps {
  catalog: ToolCatalogEntry[];
  onCancel: () => void;
  onSubmit: (input: InstallCompanyToolRequest) => Promise<void>;
  extraRoles?: string[];
}

type Stage =
  | { kind: "pick" }
  | { kind: "fill"; type: ToolCatalogEntry };

export function AddToolModal({ catalog, onCancel, onSubmit, extraRoles }: AddToolModalProps) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });

  return (
    <Modal
      open
      title={stage.kind === "pick" ? "Add tool" : `Install ${stage.type.displayName}`}
      onClose={onCancel}
      width="min(520px, 92vw)"
    >
      <div className="px-5 py-5">
        {stage.kind === "pick" ? (
          <PickStage
            catalog={catalog}
            onPick={(type) => setStage({ kind: "fill", type })}
          />
        ) : (
          <FillStage
            entry={stage.type}
            extraRoles={extraRoles}
            onBack={() => setStage({ kind: "pick" })}
            onSubmit={onSubmit}
          />
        )}
      </div>
    </Modal>
  );
}

function PickStage({
  catalog,
  onPick,
}: {
  catalog: ToolCatalogEntry[];
  onPick: (entry: ToolCatalogEntry) => void;
}) {
  if (catalog.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-white/55">
        No tool handlers available yet.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-white/55">Pick a tool type to install.</p>
      <div className="space-y-2 max-h-72 overflow-y-auto -mx-1 px-1">
        {catalog.map((entry) => (
          <button
            key={entry.type}
            onClick={() => onPick(entry)}
            className="w-full text-left flex items-start gap-3 rounded-lg px-3.5 py-3 bg-white/4 hover:bg-white/8 transition-colors cursor-pointer"
          >
            <div className="size-7 rounded-md bg-white/8 flex items-center justify-center shrink-0">
              <Plug className="size-3.5 text-white/60" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-white/90 font-medium">
                {entry.displayName}
              </p>
              <p className="text-[11px] text-white/55 leading-relaxed mt-1">
                {entry.description}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function FillStage({
  entry,
  onBack,
  onSubmit,
  extraRoles,
}: {
  entry: ToolCatalogEntry;
  onBack: () => void;
  onSubmit: (input: InstallCompanyToolRequest) => Promise<void>;
  extraRoles?: string[];
}) {
  const [label, setLabel] = useState("");
  const [credentials, setCredentials] = useState<Record<string, unknown>>(
    initialValues(entry.credentialFields),
  );
  const [metadata, setMetadata] = useState<Record<string, unknown>>(
    initialValues(entry.metadataFields),
  );
  const [allowedRoles, setAllowedRoles] = useState<AgentRole[]>([]);
  const [testAfterInstall, setTestAfterInstall] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    if (!label.trim()) return false;
    for (const f of entry.credentialFields) {
      if (f.required) {
        const v = credentials[f.name];
        if (v === undefined || v === null || v === "") return false;
      }
    }
    return true;
  }, [label, credentials, entry.credentialFields]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        type: entry.type,
        label: label.trim(),
        credentials,
        metadata,
        allowedRoles,
        testAfterInstall: testAfterInstall && entry.hasTestConnection,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Install failed. Check the credentials and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-[11px] text-white/55 hover:text-white/85 transition-colors cursor-pointer"
      >
        <ChevronLeft className="size-3.5" /> Back to picker
      </button>

      <div>
        <label className="block text-[11px] uppercase tracking-wider text-white/55 mb-1">
          Label
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`e.g. ${entry.displayName} (Crypoch)`}
          className="w-full px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[13px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30"
        />
        <p className="text-[10px] text-white/40 mt-1">
          A short name to help operators distinguish multiple tools of the same type.
        </p>
      </div>

      {entry.credentialFields.length > 0 && (
        <CredentialFieldsForm
          title="Credentials"
          fields={entry.credentialFields}
          values={credentials}
          onChange={setCredentials}
        />
      )}

      {entry.metadataFields && entry.metadataFields.length > 0 && (
        <CredentialFieldsForm
          title="Configuration"
          fields={entry.metadataFields}
          values={metadata}
          onChange={setMetadata}
        />
      )}

      <div className="space-y-2">
        <label className="block text-[11px] uppercase tracking-wider text-white/55">
          Allowed roles
        </label>
        <RoleMultiSelect
          value={allowedRoles}
          onChange={setAllowedRoles}
          extraRoles={extraRoles}
        />
        <p className="text-[10px] text-white/40">
          {allowedRoles.length > 0
            ? `Only ${allowedRoles.length} role${allowedRoles.length !== 1 ? "s" : ""} can call this tool. Auto-enabled for matching agents on install.`
            : "Visible to every agent role. Auto-enabled for every active agent on install."}
        </p>
      </div>

      {entry.hasTestConnection && (
        <label className="flex items-center gap-2 text-[12px] text-white/75 cursor-pointer">
          <input
            type="checkbox"
            checked={testAfterInstall}
            onChange={(e) => setTestAfterInstall(e.target.checked)}
            className="rounded cursor-pointer"
          />
          Test connection after install
        </label>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 text-red-200 text-xs">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onBack}
          className="px-3 py-1.5 rounded text-xs text-white/60 hover:text-white/90 hover:bg-white/5 transition-colors cursor-pointer"
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="px-3 py-1.5 rounded text-xs bg-white/10 hover:bg-white/15 text-white/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {submitting && <Loader2 className="size-3 animate-spin" />}
          {submitting ? "Installing…" : "Install tool"}
        </button>
      </div>
    </div>
  );
}

function initialValues(fields: ToolFieldHint[] | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f.name] = f.type === "boolean" ? false : f.type === "number" ? 0 : "";
  }
  return out;
}
