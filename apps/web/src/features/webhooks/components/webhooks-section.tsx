"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import type { WebhookDTO } from "@occa/shared/types";
import { useWebhooks } from "../api/use-webhooks";
import { WebhookFormModal } from "./webhook-form-modal";

// Per-company webhook connections, embedded in the Settings window. List +
// create/edit/delete. Routing (which task fires a webhook) is not set here —
// that lives in workflows. This is the connection registry only.
export function WebhooksSection({ companyId }: { companyId: string }) {
  const { webhooks, loading, error, create, update, remove, test } =
    useWebhooks(companyId);
  // null = closed, undefined = create, a webhook = edit.
  const [modal, setModal] = useState<WebhookDTO | null | undefined>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await remove(id);
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      await test(id);
    } catch {
      /* health badge reflects the failure after refetch */
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5">
          <Webhook className="size-3 text-white/35" />
          <SectionLabel>Webhooks</SectionLabel>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setModal(undefined)}>
          <Plus className="size-3" />
          Add
        </Button>
      </div>

      {error && <Alert variant="error">Couldn&apos;t load webhooks.</Alert>}

      <Card variant="recessed" padding="none">
        {loading ? (
          <div className="px-4 py-3 text-[12px] text-white/35">Loading…</div>
        ) : webhooks.length === 0 ? (
          <div className="px-4 py-4 text-[12px] text-white/40 leading-relaxed">
            No webhooks yet. Add one to connect this company to an outbound
            endpoint.
          </div>
        ) : (
          <ul>
            {webhooks.map((wh, i) => (
              <WebhookRow
                key={wh.id}
                webhook={wh}
                first={i === 0}
                confirming={confirmId === wh.id}
                busy={busyId === wh.id}
                testing={testingId === wh.id}
                onTest={() => void handleTest(wh.id)}
                onEdit={() => setModal(wh)}
                onAskDelete={() => setConfirmId(wh.id)}
                onCancelDelete={() => setConfirmId(null)}
                onConfirmDelete={() => void handleDelete(wh.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-2.5 text-[11px] text-white/35 leading-relaxed px-1">
        A webhook is an outbound connection for this company. Which task fires
        which webhook is decided in workflows, not here.
      </p>

      {modal !== null && (
        <WebhookFormModal
          editing={modal}
          onClose={() => setModal(null)}
          onCreate={create}
          onUpdate={update}
        />
      )}
    </section>
  );
}

function WebhookRow({
  webhook,
  first,
  confirming,
  busy,
  testing,
  onTest,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  webhook: WebhookDTO;
  first: boolean;
  confirming: boolean;
  busy: boolean;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-3 px-4 py-3 ${first ? "" : "border-t border-white/6"}`}
    >
      <span
        className={`size-1.5 rounded-full shrink-0 ${webhook.enabled ? "bg-emerald-400" : "bg-white/20"}`}
        title={webhook.enabled ? "Enabled" : "Disabled"}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-white/85 truncate">
            {webhook.name}
          </span>
          <HealthBadge webhook={webhook} />
        </div>
        <p className="mt-0.5 text-[11px] text-white/40 font-mono truncate">
          {webhook.targetUrl}
        </p>
      </div>

      {confirming ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-white/45">Remove?</span>
          <Button
            variant="danger"
            size="sm"
            onClick={onConfirmDelete}
            disabled={busy}
          >
            {busy ? "…" : "Yes"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancelDelete}>
            No
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onTest}
            disabled={testing}
            className="p-1.5 rounded-md text-white/40 hover:text-sky-300 hover:bg-sky-500/10 transition cursor-pointer disabled:opacity-50"
            title="Send test delivery"
          >
            {testing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 rounded-md text-white/40 hover:text-white/80 hover:bg-white/6 transition cursor-pointer"
            title="Edit"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onAskDelete}
            className="p-1.5 rounded-md text-white/40 hover:text-red-400 hover:bg-red-500/10 transition cursor-pointer"
            title="Delete"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}

function HealthBadge({ webhook }: { webhook: WebhookDTO }) {
  if (!webhook.lastDeliveredAt || !webhook.lastStatus) {
    return (
      <span className="shrink-0 text-[10px] text-white/30">never fired</span>
    );
  }
  const ok = /^2\d\d$/.test(webhook.lastStatus);
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        ok ? "bg-emerald-400/12 text-emerald-300" : "bg-red-400/12 text-red-300"
      }`}
      title={webhook.lastError ?? `Last status ${webhook.lastStatus}`}
    >
      {ok ? "ok" : webhook.lastStatus}
    </span>
  );
}
