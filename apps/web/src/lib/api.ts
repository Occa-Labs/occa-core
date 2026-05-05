import type {
  AgentResponse,
  AgentSkillSyncAction,
  ApprovalStatus,
  AuthUser,
  CancelTraceRequest,
  CompanyResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  DecideApprovalResponse,
  ListActivityResponse,
  ListAgentFilesResponse,
  ListAgentSkillSyncsResponse,
  ListApprovalsResponse,
  CreateRoutineRequest,
  CreateTaskRequest,
  ImportSkillRequest,
  ListAgentsResponse,
  ListRoutinesResponse,
  ListTraceEventsResponse,
  ListTracesResponse,
  ListSkillsResponse,
  ListTasksResponse,
  CreateTaskCommentRequest,
  TaskCommentResponse,
  MeResponse,
  PauseCompanyRequest,
  ProbeRequest,
  ProbeResponse,
  RoutineResponse,
  TraceResponse,
  SkillResponse,
  SyncAgentSkillsRequest,
  TaskResponse,
  UpdateAgentRequest,
  UpdateCompanyRequest,
  UpdateRoutineRequest,
  UpdateSkillRequest,
  UpdateTaskRequest,
} from "@occa/shared/types";

// Per-feature API methods live in this file transitionally. New work goes
// in `features/<name>/api/`. The fetch helper + ApiError now live in
// `lib/api-client.ts` — re-exported here so existing imports keep working
// until each feature is migrated.
import {
  ApiError,
  getStoredToken,
  request,
  setStoredToken,
  API_BASE,
} from "./api-client";

export { ApiError, getStoredToken, request, setStoredToken, API_BASE };

export interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface VerifyResponse {
  token: string;
  user: AuthUser;
}

export interface AuthMeResponse {
  user: AuthUser;
}

export const authApi = {
  // Legacy nonce/sign flow — kept while web migrates to Privy. Safe to
  // remove once /api/auth/privy is the only sign-in path.
  requestNonce: (walletAddress: string) =>
    request<NonceResponse>("/api/auth/nonce", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }),
  verify: (input: {
    walletAddress: string;
    nonce: string;
    signature: string;
  }) =>
    request<VerifyResponse>("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Exchange a Privy access token for an OCCA JWT. Server extracts the
  // user's linked Solana wallet from Privy and upserts it as the OCCA
  // identity.
  privy: (accessToken: string) =>
    request<VerifyResponse>("/api/auth/privy", {
      method: "POST",
      body: JSON.stringify({ accessToken }),
    }),

  me: () => request<AuthMeResponse>("/api/auth/me"),
};

export const meApi = {
  get: () => request<MeResponse>("/api/me"),
};

export const adaptersApi = {
  probeOpenclaw: (input: ProbeRequest) =>
    request<ProbeResponse>("/api/adapters/openclaw/probe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

// ── On-chain Registry ──────────────────────────────────────────────────────
// Both endpoints are idempotent: re-calling after a successful anchor
// returns `alreadyRegistered: true` with the existing fields. Server holds
// the operator hot wallet and signs `controlling_authority` for MVP.
export interface RegisterCompanyOnChainResponse {
  alreadyRegistered: boolean;
  companyPda: string;
  controllingAuthority: string;
  chainNonce: number;
  chainTxSignature: string | null;
}

export interface RegisterAgentOnChainRequest {
  agentAddress: string;
  derivationSignature: string;
  derivationMessageVersion?: number;
}

export interface RegisterAgentOnChainResponse {
  alreadyRegistered: boolean;
  agentPda: string;
  agentAddress: string;
  agentIndex: number;
  derivationMessageVersion?: number;
  agentChainTxSignature: string | null;
}

export interface BatchPrepareAgentsRequest {
  agentIds: string[];
}

export interface BatchPrepareAgentsResponse {
  companyPda: string;
  derivationMessageVersion: number;
  hires: Array<{
    agentId: string;
    agentIndex: number | null;
    alreadyRegistered: boolean;
  }>;
  /** Canonical message FE must sign with the user's wallet. */
  batchMessage: string;
}

export interface BatchRegisterAgentsRequest {
  derivationSignature: string;
  derivationMessageVersion?: number;
  hires: Array<{ agentId: string; agentAddress: string }>;
}

export interface BatchRegisterAgentsResponse {
  alreadyRegistered: boolean;
  derivationMessageVersion?: number;
  registered: Array<
    | {
        agentId: string;
        agentPda: string;
        agentAddress: string;
        agentIndex: number;
        agentChainTxSignature: string;
        alreadyRegistered: false;
      }
    | {
        agentId: string;
        agentPda: string | null;
        alreadyRegistered: true;
      }
  >;
}

export const chainApi = {
  registerCompany: (companyId: string) =>
    request<RegisterCompanyOnChainResponse>(
      `/api/chain/companies/${companyId}/register`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  registerAgent: (agentId: string, input: RegisterAgentOnChainRequest) =>
    request<RegisterAgentOnChainResponse>(
      `/api/chain/agents/${agentId}/register`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  batchPrepareAgents: (companyId: string, input: BatchPrepareAgentsRequest) =>
    request<BatchPrepareAgentsResponse>(
      `/api/chain/companies/${companyId}/agents/batch-prepare`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  batchRegisterAgents: (companyId: string, input: BatchRegisterAgentsRequest) =>
    request<BatchRegisterAgentsResponse>(
      `/api/chain/companies/${companyId}/agents/batch-register`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
};

export const companiesApi = {
  get: (id: string) => request<CompanyResponse>(`/api/companies/${id}`),
  update: (id: string, input: UpdateCompanyRequest) =>
    request<CompanyResponse>(`/api/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  pause: (id: string, input: PauseCompanyRequest = {}) =>
    request<CompanyResponse>(`/api/companies/${id}/pause`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resume: (id: string) =>
    request<CompanyResponse>(`/api/companies/${id}/resume`, {
      method: "POST",
    }),
};

export const tasksApi = {
  list: () => request<ListTasksResponse>("/api/tasks"),
  create: (input: CreateTaskRequest) =>
    request<TaskResponse>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: UpdateTaskRequest) =>
    request<TaskResponse>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
  rerun: (id: string) =>
    request<TaskResponse>(`/api/tasks/${id}/rerun`, { method: "POST" }),
  addComment: (id: string, input: CreateTaskCommentRequest) =>
    request<TaskCommentResponse>(`/api/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export const skillsApi = {
  list: (opts?: { role?: string }) => {
    const qs = opts?.role ? `?role=${encodeURIComponent(opts.role)}` : "";
    return request<ListSkillsResponse>(`/api/skills${qs}`);
  },
  get: (id: string) => request<SkillResponse>(`/api/skills/${id}`),
  import: (input: ImportSkillRequest) =>
    request<SkillResponse>("/api/skills/import", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (id: string, input: UpdateSkillRequest) =>
    request<SkillResponse>(`/api/skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/skills/${id}`, { method: "DELETE" }),
  fileUrl: (id: string, path: string) =>
    `${API_BASE}/api/skills/${id}/files/${path}`,
};

export const agentsApi = {
  list: () => request<ListAgentsResponse>("/api/agents"),
  get: (id: string) => request<AgentResponse>(`/api/agents/${id}`),
  create: (input: CreateAgentRequest) =>
    request<CreateAgentResponse>("/api/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (id: string, input: UpdateAgentRequest) =>
    request<AgentResponse>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),
  syncSkills: (id: string, input: SyncAgentSkillsRequest) =>
    request<AgentResponse>(`/api/agents/${id}/skills/sync`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  files: (id: string) =>
    request<ListAgentFilesResponse>(`/api/agents/${id}/files`),
  createStream: async (
    input: CreateAgentRequest,
    onEvent: (evt: {
      status: "running" | "done";
      step: string;
      label?: string;
    }) => void,
    signal?: AbortSignal,
  ): Promise<CreateAgentResponse> => {
    const token = getStoredToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    let currentData = "";
    return new Promise<CreateAgentResponse>((resolve, reject) => {
      const pump = (): Promise<void> =>
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new ApiError(0, { error: "stream_closed" }));
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop()!;
            for (const line of lines) {
              if (line === "") {
                if (currentData !== "") {
                  try {
                    const payload = JSON.parse(currentData) as Record<
                      string,
                      unknown
                    >;
                    if (currentEvent === "done") {
                      resolve(payload as unknown as CreateAgentResponse);
                      reader.cancel().catch(() => {});
                      return;
                    } else if (currentEvent === "error") {
                      reject(new ApiError(502, payload));
                      reader.cancel().catch(() => {});
                      return;
                    } else if (currentEvent === "step") {
                      onEvent(
                        payload as {
                          status: "running" | "done";
                          step: string;
                          label?: string;
                        },
                      );
                    }
                  } catch {
                    /* malformed JSON, skip */
                  }
                }
                currentEvent = "";
                currentData = "";
              } else if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                currentData += line.slice(5).trim();
              }
            }
            return pump();
          })
          .catch(reject);
      void pump();
    });
  },
  reprovisionStream: async (
    id: string,
    onEvent: (evt: {
      status: "running" | "done";
      step: string;
      label?: string;
    }) => void,
    signal?: AbortSignal,
  ): Promise<CreateAgentResponse> => {
    const token = getStoredToken();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/agents/${id}/reprovision`, {
      method: "POST",
      headers,
      signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    let currentData = "";
    return new Promise<CreateAgentResponse>((resolve, reject) => {
      const pump = (): Promise<void> =>
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              reject(new ApiError(0, { error: "stream_closed" }));
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop()!;
            for (const line of lines) {
              if (line === "") {
                if (currentData !== "") {
                  try {
                    const payload = JSON.parse(currentData) as Record<
                      string,
                      unknown
                    >;
                    if (currentEvent === "done") {
                      resolve(payload as unknown as CreateAgentResponse);
                      reader.cancel().catch(() => {});
                      return;
                    } else if (currentEvent === "error") {
                      reject(new ApiError(502, payload));
                      reader.cancel().catch(() => {});
                      return;
                    } else if (currentEvent === "step") {
                      onEvent(
                        payload as {
                          status: "running" | "done";
                          step: string;
                          label?: string;
                        },
                      );
                    }
                  } catch {
                    /* malformed JSON, skip */
                  }
                }
                currentEvent = "";
                currentData = "";
              } else if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                currentData += line.slice(5).trim();
              }
            }
            return pump();
          })
          .catch(reject);
      void pump();
    });
  },
  chatStream: async (
    id: string,
    message: string,
    conversationId: string,
    onEvent: (evt: { stream: string; data: Record<string, unknown> }) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    const token = getStoredToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/agents/${id}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, conversationId }),
      signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    // Parse SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    let currentData = "";
    return new Promise<string>((resolve, reject) => {
      const pump = (): Promise<void> =>
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve("");
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop()!;
            for (const line of lines) {
              if (line === "") {
                // Event boundary — dispatch accumulated block
                if (currentData !== "") {
                  try {
                    const payload = JSON.parse(currentData) as Record<
                      string,
                      unknown
                    >;
                    if (currentEvent === "done") {
                      resolve(
                        typeof payload.reply === "string" ? payload.reply : "",
                      );
                      reader.cancel().catch(() => {});
                      return;
                    } else if (currentEvent === "error") {
                      reject(new ApiError(502, payload));
                      reader.cancel().catch(() => {});
                      return;
                    } else {
                      onEvent(
                        payload as {
                          stream: string;
                          data: Record<string, unknown>;
                        },
                      );
                    }
                  } catch {
                    /* malformed JSON, skip */
                  }
                }
                currentEvent = "";
                currentData = "";
              } else if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                currentData += line.slice(5).trim();
              }
            }
            return pump();
          })
          .catch(reject);
      void pump();
    });
  },
  listSkillSyncs: (id: string) =>
    request<ListAgentSkillSyncsResponse>(`/api/agents/${id}/skills/syncs`),
  resyncSkill: (id: string, skillKey: string, action?: AgentSkillSyncAction) =>
    request<{ sync: ListAgentSkillSyncsResponse["syncs"][number] }>(
      `/api/agents/${id}/skills/${encodeURIComponent(skillKey)}/resync`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),
  listTraces: (id: string, opts?: { limit?: number; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return request<ListTracesResponse>(
      `/api/agents/${id}/traces${qs ? `?${qs}` : ""}`,
    );
  },
  activity: (id: string, opts?: { limit?: number; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return request<ListActivityResponse>(
      `/api/agents/${id}/activity${qs ? `?${qs}` : ""}`,
    );
  },
};

export const tracesApi = {
  get: (id: string) => request<TraceResponse>(`/api/traces/${id}`),
  events: (id: string, afterSeq = 0) =>
    request<ListTraceEventsResponse>(
      `/api/traces/${id}/events?afterSeq=${afterSeq}`,
    ),
  cancel: (id: string, input: CancelTraceRequest = {}) =>
    request<TraceResponse>(`/api/traces/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export const routinesApi = {
  list: () => request<ListRoutinesResponse>("/api/routines"),
  get: (id: string) => request<RoutineResponse>(`/api/routines/${id}`),
  create: (input: CreateRoutineRequest) =>
    request<RoutineResponse>("/api/routines", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (id: string, input: UpdateRoutineRequest) =>
    request<RoutineResponse>(`/api/routines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/routines/${id}`, { method: "DELETE" }),
};

export interface DevResetResponse {
  ok: boolean;
  deleted: { companies: number; otherUsers: number; nonces: number };
}

export interface DevResetGatewayResponse {
  ok: boolean;
  dryRun: boolean;
  target: string;
  candidates: string[];
  removed: string[];
  failures: string[];
  stdout: string;
  stderr: string;
}

export interface DevSeedApprovalResponse {
  ok: boolean;
  approvalId: string;
}

export const devApi = {
  reset: () => request<DevResetResponse>("/api/dev/reset", { method: "POST" }),
  resetGateway: (opts?: { dryRun?: boolean }) =>
    request<DevResetGatewayResponse>(
      `/api/dev/reset-gateway${opts?.dryRun ? "?dryRun=1" : ""}`,
      { method: "POST" },
    ),
  seedApproval: () =>
    request<DevSeedApprovalResponse>("/api/dev/seed-approval", {
      method: "POST",
    }),
};

export type KickoffRoleCategory =
  | "c_suite"
  | "leadership"
  | "engineering"
  | "product_design"
  | "marketing_growth"
  | "editorial_content"
  | "operations_admin"
  | "sales_success"
  | "data_research"
  | "web3";

export interface KickoffRoleEntry {
  key: string;
  label: string;
  description: string;
  category: KickoffRoleCategory;
  defaultName: string;
}

export interface KickoffRolesResponse {
  roles: KickoffRoleEntry[];
  maxHires: number;
}

export interface KickoffStartRequest {
  description?: string | null;
  niche?: string | null;
  audience?: string | null;
  brandVoice?: string | null;
  contentPillars?: string[];
  preset?: "bootstrap" | "standard" | "full";
  roles?: string[];
}

export interface KickoffStartResponse {
  ok: true;
  hiredAgentIds: string[];
}

export interface KickoffAgentStatus {
  id: string;
  name: string;
  role: string;
  provisioningState: "pending" | "provisioning" | "ready" | "failed";
  provisioningError: string | null;
  externalAgentId: string | null;
}

export interface KickoffStatusFrame {
  kickoffState: "not_started" | "provisioning" | "completed";
  agents: KickoffAgentStatus[];
}

async function streamSSE(
  path: string,
  init: RequestInit,
  onEvent: (eventName: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/event-stream");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal });
  } catch (err) {
    // Aborted fetches (strict-mode double-effect, unmount) are normal — no
    // need to log as an error. Real failures still surface.
    const aborted =
      signal?.aborted ||
      (err as { name?: string } | null)?.name === "AbortError";
    if (!aborted) {
      console.error(`[streamSSE] fetch failed path=${path}`, err);
    }
    throw err;
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    console.error(`[streamSSE] non-ok response`, { status: res.status, body });
    throw new ApiError(res.status, body);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = "";
  let currentData = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (line === "") {
        if (currentData !== "") {
          try {
            const payload = JSON.parse(currentData);
            onEvent(currentEvent || "message", payload);
          } catch {
            /* malformed JSON, skip */
          }
        }
        currentEvent = "";
        currentData = "";
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData += line.slice(5).trim();
      }
    }
  }
}

export const kickoffApi = {
  listRoles: () =>
    request<KickoffRolesResponse>("/api/companies/kickoff/roles"),
  start: (companyId: string, input: KickoffStartRequest) =>
    request<KickoffStartResponse>(`/api/companies/${companyId}/kickoff/start`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reset: (companyId: string) =>
    request<{ ok: true }>(`/api/companies/${companyId}/kickoff/reset`, {
      method: "POST",
    }),
  streamStatus: (
    companyId: string,
    onFrame: (frame: KickoffStatusFrame) => void,
    onDone: (finalState: KickoffStatusFrame["kickoffState"]) => void,
    signal?: AbortSignal,
  ) =>
    streamSSE(
      `/api/companies/${companyId}/kickoff/status`,
      { method: "GET" },
      (event, data) => {
        if (event === "status") onFrame(data as KickoffStatusFrame);
        else if (event === "done")
          onDone(
            (data as { kickoffState: KickoffStatusFrame["kickoffState"] })
              .kickoffState,
          );
      },
      signal,
    ),
};

export const approvalsApi = {
  list: (opts?: { status?: ApprovalStatus }) => {
    const qs = opts?.status ? `?status=${opts.status}` : "";
    return request<ListApprovalsResponse>(`/api/approvals${qs}`);
  },
  decide: (
    id: string,
    decision: "approve" | "reject",
    rejectionReason?: string,
  ) =>
    request<DecideApprovalResponse>(`/api/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, rejectionReason }),
    }),
};
