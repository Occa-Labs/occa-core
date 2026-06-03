"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketplaceInviteDTO } from "@occa/shared/types";
import { marketplaceApi } from "@/lib/api";

export interface OutgoingInvites {
  invites: MarketplaceInviteDTO[];
  reload: () => Promise<void>;
}

// The sender's "Sent" view — invites this user issued for other owners'
// agents, read-only, with their accept/decline state. No actions: once
// sent, the outcome is the agent owner's to decide.
export function useOutgoingInvites(): OutgoingInvites {
  const [invites, setInvites] = useState<MarketplaceInviteDTO[]>([]);

  const reload = useCallback(async () => {
    try {
      const res = await marketplaceApi.listOutgoingInvites();
      setInvites(res.invites);
    } catch {
      /* silent — empty is fine */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { invites, reload };
}
