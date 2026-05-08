"use client";

import { useQuery } from "@tanstack/react-query";
import {
  APPROVAL_ACTION_TYPES,
  type ApprovalDTO,
  type ApprovalStatus,
} from "@occa/shared/types";
import { approvalsApi } from "@/lib/api";
import { approvalKeys } from "./keys";

// Hide approvals whose actionType the FE doesn't know how to render or
// decide. Defends against legacy rows from removed features (e.g.
// agent-can-hire-agent rolled back 2026-05-09) so they don't pollute the
// pending list before the cleanup script runs.
const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set(APPROVAL_ACTION_TYPES);

const REFETCH_INTERVAL_MS = 15_000;

export function useApprovalsList(
  enabled: boolean,
  status: ApprovalStatus = "pending",
) {
  return useQuery({
    queryKey: approvalKeys.list({ status }),
    queryFn: async (): Promise<ApprovalDTO[]> => {
      const { approvals } = await approvalsApi.list({ status });
      return approvals.filter((a) => KNOWN_ACTION_TYPES.has(a.actionType));
    },
    enabled,
    refetchInterval: status === "pending" ? REFETCH_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
}
