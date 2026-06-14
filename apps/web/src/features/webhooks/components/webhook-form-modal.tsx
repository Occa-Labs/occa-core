"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import type {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  WebhookDTO,
} from "@occa/shared/types";

// One modal for both create and edit. `editing` present = edit mode: the
// secret field is optional (blank keeps the current one). Create mode
// requires a secret.
export function WebhookFormModal({
  editing,
  onClose,
  onCreate,
  onUpdate,
}: {
  editing?: WebhookDTO | null;
  onClose: () => void;
  onCreate: (input: CreateWebhookRequest) => Promise<unknown>;
  onUpdate: (id: string, input: UpdateWebhookRequest) => Promise<unknown>;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState(editing?.name ?? "");
  const [targetUrl, setTargetUrl] = useState(editing?.targetUrl ?? "");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validUrl = /^https?:\/\//i.test(targetUrl.trim());
  const canSave =
    name.trim().length > 0 &&
    validUrl &&
    (isEdit || secret.trim().length > 0) &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit && editing) {
        const patch: UpdateWebhookRequest = {
          name: name.trim(),
          targetUrl: targetUrl.trim(),
          enabled,
        };
        if (secret.trim().length > 0) patch.secret = secret.trim();
        await onUpdate(editing.id, patch);
      } else {
        await onCreate({
          name: name.trim(),
          targetUrl: targetUrl.trim(),
          secret: secret.trim(),
          enabled,
        });
      }
      onClose();
    } catch {
      setError("Couldn't save. Check the URL and try again.");
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? "Edit webhook" : "Add webhook"}
      subtitle="An outbound connection for this company"
      onClose={onClose}
      width="min(480px, 92vw)"
      footer={
        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add webhook"}
          </Button>
        </div>
      }
    >
      <div className="px-5 py-5 space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Publish"
            className={inputClass}
          />
        </Field>

        <Field label="Target URL">
          <input
            type="url"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://example.com/api/publish"
            className={inputClass}
          />
          {targetUrl.length > 0 && !validUrl && (
            <p className="mt-1 text-[11px] text-amber-300/70">
              Must start with http:// or https://
            </p>
          )}
        </Field>

        <Field label={isEdit ? "Secret" : "Signing secret"}>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              isEdit
                ? editing?.hasSecret
                  ? "Leave blank to keep current"
                  : "Set a secret"
                : "Used to sign requests (HMAC-SHA256)"
            }
            className={`${inputClass} font-mono`}
          />
          <p className="mt-1 text-[11px] text-white/35">
            Sent as an HMAC-SHA256 signature so the receiver can verify the
            request. Never shown again after saving.
          </p>
        </Field>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded cursor-pointer"
          />
          <span className="text-[13px] text-white/80">Enabled</span>
        </label>
      </div>
    </Modal>
  );
}

const inputClass =
  "w-full px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[13px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="text-[11px] text-white/45 font-medium">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}
