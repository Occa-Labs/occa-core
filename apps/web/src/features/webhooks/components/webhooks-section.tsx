"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";
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
//
// `embedded` drops the self-contained SectionLabel header (the host pane
// already supplies a title) and keeps just the Add action above the list.
export function WebhooksSection({
  companyId,
  embedded = false,
}: {
  companyId: string;
  embedded?: boolean;
}) {
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
      {embedded ? (
        <div className="flex justify-end mb-2">
          <Button variant="ghost" size="sm" onClick={() => setModal(undefined)}>
            <Plus className="size-3" />
            Add
          </Button>
        </div>
      ) : (
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
      )}

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

      <ExamplePayloadCard />

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

// The exact shape every webhook for this company delivers on
// `task.completed`. Destination-neutral and identical across companies, so
// it lives here as static reference — devs building a receiver see what to
// expect. Illustrative placeholder values, not live data.
const EXAMPLE_PAYLOAD = `{
  "event": "task.completed",
  "occurredAt": "2026-06-15T08:30:00.000Z",
  "company": { "id": "<company-uuid>", "name": "Your Company" },
  "task": {
    "id": "1042",
    "title": "Task title",
    "tags": ["topic"],
    "taskType": "delegated"
  },
  "document": {
    "title": "Deliverable title",
    "content": "# Markdown body\\n\\nThe agent's clean deliverable…",
    "format": "markdown",
    "tags": ["topic"]
  },
  "agent": { "name": "Agent name", "role": "agent_role" },
  "delegatedBy": { "name": "Delegating agent", "role": "head_role" },
  "trace": { "id": "<trace-id>" }
}`;

const EXAMPLE_HEADERS = `Content-Type: application/json
X-OCCA-Event: task.completed
X-OCCA-Delivery: <uuid>
X-OCCA-Signature: sha256=<hmac of the raw body, keyed by your secret>`;

// Static reference card: what this webhook POSTs to the target URL. Same
// for every company, so it documents the contract rather than any one row.
function ExamplePayloadCard() {
  const [open, setOpen] = useState(false);

  return (
    <Card variant="recessed" padding="none" className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left cursor-pointer"
      >
        {open ? (
          <ChevronDown className="size-3 text-white/35" />
        ) : (
          <ChevronRight className="size-3 text-white/35" />
        )}
        <span className="text-[11px] text-white/55">
          Example payload this webhook sends
        </span>
      </button>

      {open && (
        <div className="border-t border-white/6 px-3 py-2.5 space-y-3">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-white/30">
              Headers
            </p>
            <pre className="rounded-md bg-black/30 px-3 py-2 text-[11px] leading-relaxed font-mono text-white/65 whitespace-pre-wrap wrap-break-word overflow-auto">
              {EXAMPLE_HEADERS}
            </pre>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-white/30">
              Body (POST)
            </p>
            <pre className="rounded-md bg-black/30 px-3 py-2 text-[11px] leading-relaxed font-mono text-white/70 whitespace-pre-wrap wrap-break-word max-h-80 overflow-auto">
              {EXAMPLE_PAYLOAD}
            </pre>
          </div>
          <p className="text-[10px] text-white/30 leading-relaxed">
            Same shape for every company. The receiver maps it to whatever it
            needs.
          </p>
        </div>
      )}
    </Card>
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
  const [expanded, setExpanded] = useState(false);
  const hasDelivery = Boolean(webhook.lastDeliveredAt && webhook.lastStatus);

  return (
    <li className={first ? "" : "border-t border-white/6"}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={`size-1.5 rounded-full shrink-0 ${webhook.enabled ? "bg-emerald-400" : "bg-white/20"}`}
          title={webhook.enabled ? "Enabled" : "Disabled"}
        />

        <button
          type="button"
          onClick={() => hasDelivery && setExpanded((v) => !v)}
          disabled={!hasDelivery}
          className={`flex-1 min-w-0 text-left ${hasDelivery ? "cursor-pointer" : "cursor-default"}`}
          title={hasDelivery ? "Show last response" : undefined}
        >
          <div className="flex items-center gap-2">
            {hasDelivery &&
              (expanded ? (
                <ChevronDown className="size-3 text-white/35 shrink-0" />
              ) : (
                <ChevronRight className="size-3 text-white/35 shrink-0" />
              ))}
            <span className="text-[13px] text-white/85 truncate">
              {webhook.name}
            </span>
            <HealthBadge webhook={webhook} />
          </div>
          <p className="mt-0.5 text-[11px] text-white/40 font-mono truncate">
            {webhook.targetUrl}
          </p>
        </button>

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
      </div>

      {expanded && hasDelivery && <LastResponsePanel webhook={webhook} />}
    </li>
  );
}

// Last-delivery detail. The response body is opaque to OCCA — pretty-print
// it when it parses as JSON, otherwise show it raw. No per-destination
// field parsing: every receiver's shape renders the same way.
function LastResponsePanel({ webhook }: { webhook: WebhookDTO }) {
  const when = webhook.lastDeliveredAt
    ? new Date(webhook.lastDeliveredAt).toLocaleString()
    : "";
  const body = formatBody(webhook.lastResponse);

  return (
    <div className="mx-4 mb-3 rounded-md border border-white/8 bg-black/30">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/6 text-[10px] text-white/40">
        <span className="uppercase tracking-wide">Last response</span>
        {webhook.lastStatus && (
          <span className="font-mono text-white/55">{webhook.lastStatus}</span>
        )}
        <span className="ml-auto">{when}</span>
      </div>
      <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-white/70 whitespace-pre-wrap wrap-break-word max-h-64 overflow-auto">
        {body ?? webhook.lastError ?? "No response body."}
      </pre>
    </div>
  );
}

function formatBody(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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
