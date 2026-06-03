"use client";

import { useState } from "react";
import type { AgentDTO } from "@occa/shared/types";
import { ApiError, agentsApi } from "@/lib/api";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAnchorAgentIdentity } from "../hooks/use-anchor-agent-identity";
import { useSetAgentReceivingAddress } from "../hooks/use-set-agent-receiving";

function truncate(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white/85">{title}</p>
          <p className="mt-0.5 text-xs text-white/40">{desc}</p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </div>
  );
}

// Everything on-chain for one agent: identity anchor, personal receiving
// wallet, and marketplace listing. Composed into AgentDetail's Chain tab.
export function AgentChainPanel({
  agent,
  onReload,
}: {
  agent: AgentDTO;
  onReload: () => Promise<void> | void;
}) {
  const anchored = agent.identityAnchored;
  const hasWallet = !!agent.receivingWallet;

  const anchorHook = useAnchorAgentIdentity();
  const recv = useSetAgentReceivingAddress();
  const [addr, setAddr] = useState("");
  const [editingWallet, setEditingWallet] = useState(false);
  const [listPending, setListPending] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const anchorBusy = anchorHook.stage !== "idle" && anchorHook.stage !== "complete";
  const recvBusy = recv.stage !== "idle" && recv.stage !== "complete";

  const doAnchor = async () => {
    const ok = await anchorHook.anchor(agent.identityId);
    if (ok) await onReload();
  };
  const doSetWallet = async () => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    const ok = await recv.setAddress(agent.identityId, trimmed);
    if (ok) {
      setEditingWallet(false);
      setAddr("");
      await onReload();
    }
  };
  const toggleList = async () => {
    setListError(null);
    setListPending(true);
    try {
      await agentsApi.setAvailability(agent.id, !agent.availableForWork);
      await onReload();
    } catch (e) {
      const code =
        e instanceof ApiError
          ? (e.body as { error?: string } | null)?.error
          : undefined;
      setListError(
        code === ERROR_CODES.CHAIN_NOT_ANCHORED
          ? "Anchor on-chain first."
          : code === ERROR_CODES.RECEIVING_WALLET_UNSET
            ? "Set a receiving wallet first."
            : "Couldn't update listing.",
      );
    } finally {
      setListPending(false);
    }
  };

  const ChecklistItem = ({ done, label }: { done: boolean; label: string }) => (
    <li className="flex items-center gap-2 text-xs">
      {done ? (
        <Check className="size-3.5 text-emerald-400" />
      ) : (
        <Circle className="size-3.5 text-white/30" />
      )}
      <span className={done ? "text-white/70" : "text-white/45"}>{label}</span>
    </li>
  );

  return (
    <div className="space-y-3 p-5">
      {agent.availableForWork ? (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-400/8 p-4">
          <Check className="size-4 text-emerald-400" />
          <p className="text-sm text-emerald-100/90">
            Listed in the marketplace — other companies can invite this agent.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/8 p-4">
          <p className="text-sm font-medium text-amber-100/90">
            To list this agent in the marketplace
          </p>
          <p className="mt-0.5 text-xs text-white/50">
            Complete both so other companies can invite it and pay its
            receiving wallet.
          </p>
          <ul className="mt-2 space-y-1">
            <ChecklistItem done={anchored} label="Anchored on-chain" />
            <ChecklistItem done={hasWallet} label="Receiving wallet set" />
          </ul>
        </div>
      )}

      <Row
        title="On-chain identity"
        desc="Register this agent's portable identity on Solana."
      >
        {anchored ? (
          <Badge variant="success">Anchored</Badge>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              variant="primary"
              disabled={anchorBusy || !anchorHook.walletReady}
              onClick={doAnchor}
            >
              {anchorHook.stage === "awaiting-signature"
                ? "Sign in wallet…"
                : anchorBusy
                  ? "Anchoring…"
                  : "Anchor on-chain"}
            </Button>
            {!anchorHook.walletReady && (
              <span className="text-[11px] text-white/40">Connect wallet</span>
            )}
            {anchorHook.error && (
              <span className="max-w-[200px] text-right text-[11px] text-red-300">
                {anchorHook.error}
              </span>
            )}
          </div>
        )}
      </Row>

      <Row
        title="Receiving wallet"
        desc="The agent's personal payout wallet. Work it does for any company is paid here."
      >
        {!anchored ? (
          <span className="text-[11px] text-white/40">Anchor first</span>
        ) : hasWallet && !editingWallet ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-white/80">
              {truncate(agent.receivingWallet!)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditingWallet(true)}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="Solana address"
                className="h-8 w-48 rounded-lg bg-white/8 px-2.5 font-mono text-xs text-white outline-none placeholder:text-white/30 focus:bg-white/12"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={recvBusy || !addr.trim() || !recv.walletReady}
                onClick={doSetWallet}
              >
                {recv.stage === "awaiting-signature"
                  ? "Sign…"
                  : recvBusy
                    ? "Saving…"
                    : "Set wallet"}
              </Button>
            </div>
            {recv.error && (
              <span className="max-w-[240px] text-right text-[11px] text-red-300">
                {recv.error}
              </span>
            )}
          </div>
        )}
      </Row>

      <Row
        title="Marketplace"
        desc="List this agent so other companies can invite it. Requires anchor + receiving wallet."
      >
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            variant={agent.availableForWork ? "secondary" : "primary"}
            disabled={listPending || !anchored || !hasWallet}
            onClick={toggleList}
          >
            {agent.availableForWork ? "Listed" : "List agent"}
          </Button>
          {listError && (
            <span className="text-[11px] text-red-300">{listError}</span>
          )}
        </div>
      </Row>

      {agent.agentPda && (
        <div className="rounded-2xl border border-white/8 bg-white/4 p-4">
          <p className="text-xs text-white/40">Identity PDA</p>
          <p className="mt-1 font-mono text-xs break-all text-white/70">
            {agent.agentPda}
          </p>
        </div>
      )}
    </div>
  );
}
