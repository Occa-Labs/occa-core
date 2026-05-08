// Query key factory for approvals — keep all cache lookups going through
// one place so list/detail invalidations stay in sync.

import type { ApprovalStatus } from "@occa/shared/types";

export const approvalKeys = {
  all: ["approvals"] as const,
  lists: () => [...approvalKeys.all, "list"] as const,
  list: (filter: { status?: ApprovalStatus }) =>
    [...approvalKeys.lists(), filter] as const,
};
