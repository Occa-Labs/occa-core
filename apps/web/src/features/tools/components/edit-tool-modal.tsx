"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type {
  AgentRole,
  CompanyToolDTO,
  ToolCatalogEntry,
  UpdateCompanyToolRequest,
} from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { RoleMultiSelect } from "@/components/ui/role-multi-select";
import { CredentialFieldsForm } from "./credential-fields-form";

interface EditToolModalProps {
  tool: CompanyToolDTO;
  catalog: ToolCatalogEntry | undefined;
  onCancel: () => void;
  onSubmit: (input: UpdateCompanyToolRequest) => Promise<void>;
  extraRoles?: string[];
}

export function EditToolModal({
  tool,
  catalog,
  onCancel,
  onSubmit,
  extraRoles,
}: EditToolModalProps) {
  const [label, setLabel] = useState(tool.label);
  const [rotateCredentials, setRotateCredentials] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, unknown>>(
    initialValues(catalog?.credentialFields),
  );
  const [allowedRoles, setAllowedRoles] = useState<AgentRole[]>(
    tool.allowedRoles ?? [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    if (!label.trim()) return false;
    if (rotateCredentials) {
      const fields = catalog?.credentialFields ?? [];
      for (const f of fields) {
        if (f.required) {
          const v = credentials[f.name];
          if (v === undefined || v === null || v === "") return false;
        }
      }
    }
    return true;
  }, [label, rotateCredentials, credentials, catalog]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: UpdateCompanyToolRequest = {};
      if (label.trim() !== tool.label) payload.label = label.trim();
      if (rotateCredentials) payload.credentials = credentials;
      if (!rolesEqual(allowedRoles, tool.allowedRoles ?? [])) {
        payload.allowedRoles = allowedRoles;
      }
      if (Object.keys(payload).length === 0) {
        onCancel();
        return;
      }
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title={`Edit ${tool.label}`} onClose={onCancel} width="min(500px, 92vw)">
      <div className="px-5 py-5 space-y-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/55 mb-1">
            Label
          </label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[13px] text-white/90 focus:outline-none focus:border-white/30"
          />
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/55 mb-1">
            Allowed roles
          </label>
          <RoleMultiSelect
            value={allowedRoles}
            onChange={setAllowedRoles}
            extraRoles={extraRoles}
          />
          <p className="text-[10px] text-white/40 mt-1">
            Existing agent toggles stay as-is; the gate just controls which roles
            can have this tool surfaced going forward.
          </p>
        </div>

        <div className="rounded-md bg-white/3 p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rotateCredentials}
              onChange={(e) => setRotateCredentials(e.target.checked)}
              className="mt-0.5 rounded cursor-pointer"
            />
            <span>
              <span className="text-[12px] text-white/85">
                Rotate credentials
              </span>
              <span className="block text-[11px] text-white/45 mt-0.5">
                Stored credentials are encrypted at rest and not shown here.
                Toggle on to replace them with new values.
              </span>
            </span>
          </label>

          {rotateCredentials && catalog?.credentialFields && (
            <div className="mt-3 pt-3 border-t border-white/8">
              <CredentialFieldsForm
                title="New credentials"
                fields={catalog.credentialFields}
                values={credentials}
                onChange={setCredentials}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 text-red-200 text-xs">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
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
            Save changes
          </button>
        </div>
      </div>
    </Modal>
  );
}

function rolesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function initialValues(
  fields: { name: string; type: "string" | "number" | "boolean" }[] | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f.name] = f.type === "boolean" ? false : f.type === "number" ? 0 : "";
  }
  return out;
}
