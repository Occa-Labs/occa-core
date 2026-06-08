"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  WebhookDTO,
  WebhookTestResponse,
} from "@occa/shared/types";
import { ApiError, webhooksApi } from "@/lib/api";

const keys = {
  list: (companyId: string) => ["webhooks", "list", companyId] as const,
};

export interface UseWebhooksResult {
  webhooks: WebhookDTO[];
  loading: boolean;
  error: string | null;
  create: (input: CreateWebhookRequest) => Promise<WebhookDTO>;
  update: (
    webhookId: string,
    input: UpdateWebhookRequest,
  ) => Promise<WebhookDTO>;
  remove: (webhookId: string) => Promise<void>;
  test: (webhookId: string) => Promise<WebhookTestResponse>;
  reload: () => Promise<void>;
}

export function useWebhooks(
  companyId: string | null,
  enabled = true,
): UseWebhooksResult {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: companyId ? keys.list(companyId) : ["webhooks", "list", "_none"],
    queryFn: () =>
      companyId
        ? webhooksApi.list(companyId)
        : Promise.resolve({ webhooks: [] }),
    enabled: enabled && Boolean(companyId),
  });

  const invalidate = useCallback(async () => {
    if (!companyId) return;
    await qc.invalidateQueries({ queryKey: keys.list(companyId) });
  }, [qc, companyId]);

  const create = useCallback(
    async (input: CreateWebhookRequest) => {
      if (!companyId) throw new Error("no company");
      const res = await webhooksApi.create(companyId, input);
      await invalidate();
      return res.webhook;
    },
    [companyId, invalidate],
  );

  const update = useCallback(
    async (webhookId: string, input: UpdateWebhookRequest) => {
      if (!companyId) throw new Error("no company");
      const res = await webhooksApi.update(companyId, webhookId, input);
      await invalidate();
      return res.webhook;
    },
    [companyId, invalidate],
  );

  const remove = useCallback(
    async (webhookId: string) => {
      if (!companyId) throw new Error("no company");
      await webhooksApi.remove(companyId, webhookId);
      await invalidate();
    },
    [companyId, invalidate],
  );

  const test = useCallback(
    async (webhookId: string) => {
      if (!companyId) throw new Error("no company");
      const res = await webhooksApi.test(companyId, webhookId);
      // Delivery updated the row's health — refresh the list.
      await invalidate();
      return res;
    },
    [companyId, invalidate],
  );

  return {
    webhooks: query.data?.webhooks ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? `api_${query.error.status}`
        : "network_error"
      : null,
    create,
    update,
    remove,
    test,
    reload: invalidate,
  };
}
