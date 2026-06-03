"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketplaceInviteDTO } from "@occa/shared/types";
import { marketplaceApi } from "@/lib/api";
import { useAcceptInvite } from "./use-accept-invite";

export interface IncomingInvites {
  invites: MarketplaceInviteDTO[];
  /** Pending invites only — drives the dock badge (history doesn't count). */
  pendingCount: number;
  busyId: string | null;
  accepter: ReturnType<typeof useAcceptInvite>;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

// Owns the agent owner's incoming hire-invite inbox: fetch + accept (signs
// create_deployment) + decline. Lifted into a hook so the dock can show a
// pending-count badge while the panel itself stays presentational and the
// fetch runs regardless of which home section is open.
export function useIncomingInvites(
  onReloadMe: () => Promise<void> | void,
): IncomingInvites {
  const [invites, setInvites] = useState<MarketplaceInviteDTO[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const accepter = useAcceptInvite();

  const reload = useCallback(async () => {
    try {
      const res = await marketplaceApi.listIncomingInvites();
      setInvites(res.invites);
    } catch {
      /* silent — empty inbox is fine */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAccept = useCallback(
    async (id: string) => {
      setBusyId(id);
      const ok = await accepter.accept(id);
      setBusyId(null);
      if (ok) {
        await reload();
        await onReloadMe();
      }
    },
    [accepter, reload, onReloadMe],
  );

  const onReject = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await marketplaceApi.rejectInvite(id);
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const pendingCount = invites.filter((i) => i.status === "pending").length;

  return { invites, pendingCount, busyId, accepter, onAccept, onReject, reload };
}
