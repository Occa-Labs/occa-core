"use client";

import { Inbox } from "lucide-react";
import type { InviteStatus, MarketplaceInviteDTO } from "@occa/shared/types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IncomingInvites } from "../hooks/use-incoming-invites";
import type { OutgoingInvites } from "../hooks/use-outgoing-invites";

// "Jun 3" — short decision date for resolved rows.
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const STATUS_LABEL: Record<InviteStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Declined",
  cancelled: "Withdrawn",
};

function StatusBadge({ status }: { status: InviteStatus }) {
  const variant =
    status === "accepted"
      ? "success"
      : status === "pending"
        ? "warning"
        : "muted";
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-[11px] font-semibold tracking-wide text-white/45 uppercase">
      {children}
    </p>
  );
}

// One invite row. `lead` is the headline (who/what); pending received
// invites get Accept/Decline, everything else shows a status badge.
function InviteRow({
  lead,
  role,
  status,
  resolvedAt,
  actions,
}: {
  lead: React.ReactNode;
  role: string;
  status: InviteStatus;
  resolvedAt: string;
  actions?: React.ReactNode;
}) {
  const pending = status === "pending";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl border p-4 ${
        pending
          ? "border-amber-400/20 bg-amber-400/8"
          : "border-white/7 bg-white/4"
      }`}
    >
      <div className="min-w-0">
        <p className={`text-sm ${pending ? "text-white/85" : "text-white/60"}`}>
          {lead}
        </p>
        <p className="mt-0.5 text-xs text-white/45">
          Role: {role}
          {!pending && <> · {shortDate(resolvedAt)}</>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions ?? <StatusBadge status={status} />}
      </div>
    </div>
  );
}

// The agent owner's + sender's combined invite Inbox. "Received" lists
// invites addressed to agents this user owns (Accept signs
// create_deployment); "Sent" lists invites this user issued for other
// owners' agents (read-only outcome). State comes from the lifted hooks so
// the dock badge and this panel share one fetch.
export function InboxPanel({
  incoming,
  outgoing,
}: {
  incoming: IncomingInvites;
  outgoing: OutgoingInvites;
}) {
  const { invites, busyId, accepter, onAccept, onReject } = incoming;

  if (invites.length === 0 && outgoing.invites.length === 0) {
    return (
      <Card
        padding="lg"
        className="flex min-h-44 flex-col items-center justify-center gap-2 text-center"
      >
        <Inbox className="size-7 text-white/35" />
        <p className="text-sm font-medium text-white/70">No invitations</p>
        <p className="max-w-xs text-xs text-white/40">
          Invites for your agents — and invites you send to other owners&apos;
          agents — show up here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {invites.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Received</SectionLabel>
          {invites.map((inv) => (
            <InviteRow
              key={inv.id}
              status={inv.status}
              role={inv.role}
              resolvedAt={inv.updatedAt}
              lead={
                <>
                  <span className="font-medium">{inv.companyName}</span> wants to
                  hire <span className="font-medium">{inv.agentName}</span>
                </>
              }
              actions={
                inv.status === "pending" ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === inv.id}
                      onClick={() => onReject(inv.id)}
                    >
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busyId === inv.id || !accepter.walletReady}
                      onClick={() => onAccept(inv.id)}
                    >
                      {busyId === inv.id
                        ? accepter.stage === "awaiting-signature"
                          ? "Sign…"
                          : "Accepting…"
                        : "Accept"}
                    </Button>
                  </>
                ) : undefined
              }
            />
          ))}
          {accepter.error && (
            <p className="text-[11px] text-red-300">{accepter.error}</p>
          )}
        </div>
      )}

      {outgoing.invites.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Sent</SectionLabel>
          {outgoing.invites.map((inv: MarketplaceInviteDTO) => (
            <InviteRow
              key={inv.id}
              status={inv.status}
              role={inv.role}
              resolvedAt={inv.updatedAt}
              lead={
                <>
                  You invited{" "}
                  <span className="font-medium">{inv.agentName}</span> to{" "}
                  <span className="font-medium">{inv.companyName}</span>
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
