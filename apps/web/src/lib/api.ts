import type {
  AgentResponse,
  AgentSkillSyncAction,
  ApprovalDTO,
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
  ListTaskCommentsResponse,
  ListTracesResponse,
  ListSkillsResponse,
  ListTaskEventsResponse,
  ListTasksResponse,
  OpenclawAdapterConfig,
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
// All state-changing instructions are signed by the user wallet (`owner`).
// The operator hot wallet is the fee-payer ONLY. Per ix the FE flow is:
//   1. POST /…/prepare    → BE returns a base64 tx with operator's
//                           fee-payer signature pre-attached.
//   2. Wallet signTx      → Privy adds the owner signature in browser.
//   3. POST /…/confirm    → BE submits the fully-signed tx, confirms,
//                           and persists the on-chain cache columns.
//
// Endpoints are idempotent: re-calling after a successful anchor returns
// `alreadyRegistered: true` with the existing fields and no `transaction`.

interface PreparedTx {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface PrepareCompanyOnChainRequest {
  metadataUri?: string;
}

export type PrepareCompanyOnChainResponse =
  | {
      alreadyRegistered: true;
      companyPda: string;
      ownerWallet: string;
      chainNonce: number;
      chainTxSignature?: string | null;
      recoveredFromChain?: boolean;
    }
  | ({
      alreadyRegistered: false;
      companyPda: string;
      ownerWallet: string;
      chainNonce: number;
    } & PreparedTx);

export interface ConfirmCompanyOnChainRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  nonce: number;
}

export interface ConfirmCompanyOnChainResponse {
  alreadyRegistered: boolean;
  companyPda: string;
  ownerWallet: string;
  chainNonce: number;
  chainTxSignature: string | null;
}

export type PrepareAgentOnChainResponse =
  | {
      alreadyRegistered: true;
      agentPda: string;
      agentIndex: number;
    }
  | ({
      alreadyRegistered: false;
      agentPda: string;
      agentIndex: number;
    } & PreparedTx);

export interface ConfirmAgentOnChainRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  agentIndex: number;
}

export interface ConfirmAgentOnChainResponse {
  alreadyRegistered: boolean;
  agentPda: string;
  agentIndex: number;
  ownerWallet?: string;
  agentChainTxSignature: string | null;
}

// Combined identity + deployment registration — kickoff batch path,
// 1 wallet popup per hire (vs 2 if identity + deployment ran separately).
export type PrepareCombinedAgentOnChainResponse =
  | {
      alreadyRegistered: true;
      agentPda: string;
      agentIndex: number;
    }
  | ({
      alreadyRegistered: false;
      identityPda: string;
      agentPubkey: string;
      agentPda: string;
      agentIndex: number;
      includesIdentity: boolean;
    } & PreparedTx);

export interface ConfirmCombinedAgentOnChainRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  agentPubkey: string;
  agentIndex: number;
}

export interface ConfirmCombinedAgentOnChainResponse {
  alreadyRegistered: boolean;
  identityPda?: string;
  agentPda: string;
  agentIndex: number;
  ownerWallet?: string;
  agentChainTxSignature: string | null;
}

// Identity registration — Phase B in the chain anchor flow. Registers
// the portable AgentIdentity PDA that `create_deployment` (Phase C)
// requires to already exist on chain.
export type PrepareIdentityOnChainResponse =
  | {
      alreadyRegistered: true;
      identityPda: string;
      agentPubkey: string;
    }
  | ({
      alreadyRegistered: false;
      identityPda: string;
      agentPubkey: string;
    } & PreparedTx);

export interface ConfirmIdentityOnChainRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  agentPubkey: string;
}

export interface ConfirmIdentityOnChainResponse {
  alreadyRegistered: boolean;
  identityPda: string;
  agentPubkey: string;
  chainTxSignature: string | null;
}

export interface PrepareSetOperatingWalletRequest {
  operatingWallet: string;
}

export interface PrepareSetOperatingWalletResponse extends PreparedTx {
  operatingWallet: string;
}

export interface ConfirmSetOperatingWalletRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  operatingWallet: string;
}

export interface ConfirmSetOperatingWalletResponse {
  operatingWallet: string;
  signature: string;
}

export const chainApi = {
  prepareCompany: (
    companyId: string,
    body: PrepareCompanyOnChainRequest = {},
  ) =>
    request<PrepareCompanyOnChainResponse>(
      `/api/chain/companies/${companyId}/register/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmCompany: (companyId: string, body: ConfirmCompanyOnChainRequest) =>
    request<ConfirmCompanyOnChainResponse>(
      `/api/chain/companies/${companyId}/register/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareIdentity: (identityId: string) =>
    request<PrepareIdentityOnChainResponse>(
      `/api/chain/agent-identities/${identityId}/register/prepare`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  confirmIdentity: (
    identityId: string,
    body: ConfirmIdentityOnChainRequest,
  ) =>
    request<ConfirmIdentityOnChainResponse>(
      `/api/chain/agent-identities/${identityId}/register/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareAgent: (agentId: string) =>
    request<PrepareAgentOnChainResponse>(
      `/api/chain/agents/${agentId}/register/prepare`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  confirmAgent: (agentId: string, body: ConfirmAgentOnChainRequest) =>
    request<ConfirmAgentOnChainResponse>(
      `/api/chain/agents/${agentId}/register/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareCombinedAgent: (agentId: string) =>
    request<PrepareCombinedAgentOnChainResponse>(
      `/api/chain/agents/${agentId}/register-combined/prepare`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  confirmCombinedAgent: (
    agentId: string,
    body: ConfirmCombinedAgentOnChainRequest,
  ) =>
    request<ConfirmCombinedAgentOnChainResponse>(
      `/api/chain/agents/${agentId}/register-combined/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareSetOperatingWallet: (
    agentId: string,
    body: PrepareSetOperatingWalletRequest,
  ) =>
    request<PrepareSetOperatingWalletResponse>(
      `/api/chain/agents/${agentId}/operating-wallet/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmSetOperatingWallet: (
    agentId: string,
    body: ConfirmSetOperatingWalletRequest,
  ) =>
    request<ConfirmSetOperatingWalletResponse>(
      `/api/chain/agents/${agentId}/operating-wallet/confirm`,
      { method: "POST", body: JSON.stringify(body) },
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
  list: (opts?: { includeArchived?: boolean }) => {
    const qs = opts?.includeArchived ? "?include_archived=1" : "";
    return request<ListTasksResponse>(`/api/tasks${qs}`);
  },
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
  comments: (id: string) =>
    request<ListTaskCommentsResponse>(`/api/tasks/${id}/comments`),
  addComment: (id: string, input: CreateTaskCommentRequest) =>
    request<TaskCommentResponse>(`/api/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  events: (id: string) =>
    request<ListTaskEventsResponse>(`/api/tasks/${id}/events`),
  archive: (id: string, input: { reason?: string }) =>
    request<TaskResponse>(`/api/tasks/${id}/archive`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unarchive: (id: string) =>
    request<TaskResponse>(`/api/tasks/${id}/unarchive`, { method: "POST" }),
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
    // Optional override — only set on chain-recovery re-pair, where the
    // server should write fresh creds + mint a new device keypair before
    // running provision. Omit for the normal "retry partial provision"
    // path (server uses the stored config).
    options?: { adapterConfig?: OpenclawAdapterConfig },
  ): Promise<CreateAgentResponse> => {
    const token = getStoredToken();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (options?.adapterConfig) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${API_BASE}/api/agents/${id}/reprovision`, {
      method: "POST",
      headers,
      body: options?.adapterConfig
        ? JSON.stringify({ adapterConfig: options.adapterConfig })
        : undefined,
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
  maxDeployments: number;
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
  deployedAgentIds: string[];
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

export interface ApprovalEditablePayload {
  title?: string;
  description?: string;
  acceptanceCriteria?: string | null;
}

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
  patch: (id: string, payload: ApprovalEditablePayload) =>
    request<{ approval: ApprovalDTO }>(`/api/approvals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ payload }),
    }),
};
