"use client";

import { useState } from "react";
import { Bot, ExternalLink } from "lucide-react";
import type { MarketplaceAgentDTO } from "@occa/shared/types";
import { marketplaceApi } from "@/lib/api";
import { ROLE_ORDER, roleLabelFor } from "@occa/shared/role-catalog";
import {
  solscanAddressUrl,
  shortenAddress,
  CLUSTER_LABEL,
} from "@/lib/solana-explorer";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";

const KNOWN_ROLE_KEYS = new Set<string>(ROLE_ORDER);

// "On OCCA since Jan 2026" — coarse tenure signal, no day-level noise.
function sinceLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

// One on-chain reference row: label on the left, explorer-linked
// truncated address on the right.
function ChainRow({
  label,
  address,
}: {
  label: string;
  address: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] font-medium text-white/45">{label}</span>
      <a
        href={solscanAddressUrl(address)}
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-1.5 font-mono text-xs text-white/70 hover:text-white"
      >
        {shortenAddress(address, 6, 6)}
        <ExternalLink className="size-3 text-white/30 group-hover:text-white/60" />
      </a>
    </div>
  );
}

interface MarketplaceAgentModalProps {
  /** The agent being viewed, or null = closed. */
  agent: MarketplaceAgentDTO | null;
  onClose: () => void;
  /** Fired after an invite is sent. */
  onSent: () => void;
}

// Public detail for a marketplace agent (owned by someone else) with an
// inline invite form. Single modal — the invite lives here, no second
// modal stacked on top.
export function MarketplaceAgentModal({
  agent,
  onClose,
  onSent,
}: MarketplaceAgentModalProps) {
  // Empty = "follow the agent's own role". We resolve a concrete default
  // per-agent in render so reopening the modal on a different agent picks
  // up its role without an effect.
  const [role, setRole] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Preselect the agent's own role when it's a known catalog key, else the
  // first role in the catalog.
  const defaultRole =
    agent && KNOWN_ROLE_KEYS.has(agent.role) ? agent.role : ROLE_ORDER[0];
  const selectedRole = role || defaultRole;

  const submit = async () => {
    if (!agent) return;
    setPending(true);
    setError(null);
    try {
      await marketplaceApi.createInvite(agent.identityId, selectedRole);
      setSent(true);
      onSent();
    } catch {
      setError(
        "Couldn't send the invite. It may be your own agent, already invited, or you don't have a company yet.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={!!agent}
      onClose={onClose}
      title="Agent"
      width="min(460px, 92vw)"
    >
      {agent && (
        <div
          className="space-y-5 px-6 py-7"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-white/8">
              <Bot className="size-6 text-white/80" />
            </div>
            <div className="flex items-center gap-1.5">
              {agent.isOwn && <Badge variant="muted">Your agent</Badge>}
              <Badge variant="success">Available</Badge>
            </div>
          </div>

          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-white">{agent.name}</h3>
            <p className="mt-1 text-sm text-white/50">
              {agent.persona ?? "General-purpose"}
            </p>
          </div>

          <div className="space-y-2.5 rounded-2xl border border-white/7 bg-white/4 px-4 py-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wide text-emerald-300/80 uppercase">
                Verified on-chain
              </span>
              <span className="text-[10px] text-white/35">{CLUSTER_LABEL}</span>
            </div>
            <ChainRow label="Identity" address={agent.identityPda} />
            <ChainRow label="Receiving wallet" address={agent.receivingWallet} />
            <ChainRow label="Owner" address={agent.ownerWallet} />
            <div className="flex items-baseline justify-between gap-3 border-t border-white/6 pt-2.5">
              <span className="text-[11px] font-medium text-white/45">
                On OCCA since
              </span>
              <span className="text-xs text-white/70">
                {sinceLabel(agent.createdAt)}
              </span>
            </div>
          </div>

          {agent.isOwn ? (
            <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-center text-[13px] text-white/55">
              This is your own agent. Deploy it to a company from your Agents
              window — cross-owner invites are for agents owned by others.
            </div>
          ) : sent ? (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-3 text-center text-[13px] text-emerald-100/90">
              Invite sent. The owner accepts it from their home.
            </div>
          ) : (
            <div className="space-y-3 border-t border-white/8 pt-5">
              <p className="text-sm font-medium text-white/85">
                Invite to your company
              </p>
              <Select
                label="Role"
                value={selectedRole}
                onChange={(e) => setRole(e.target.value)}
              >
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {roleLabelFor(r)}
                  </option>
                ))}
              </Select>
              {error && <p className="text-xs text-red-300">{error}</p>}
              <Button
                variant="primary"
                size="lg"
                block
                disabled={pending}
                onClick={submit}
              >
                {pending ? "Sending…" : "Send invite"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
