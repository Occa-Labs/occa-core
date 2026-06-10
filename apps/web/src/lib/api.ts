import type {
  AgentResponse,
  MarketplaceAgentsResponse,
  MarketplaceInvitesResponse,
  AgentSkillSyncAction,
  ApprovalDTO,
  ApprovalStatus,
  AuthUser,
  CancelTraceRequest,
  CompanyResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  DecideApprovalResponse,
  DismissApprovalResponse,
  ListActivityResponse,
  ListAgentFilesResponse,
  UpdateAgentFileRequest,
  UpdateAgentFileResponse,
  ListAgentSkillSyncsResponse,
  ListApprovalsResponse,
  ListChatMessagesResponse,
  CreateRoutineRequest,
  CreateTaskRequest,
  ImportSkillRequest,
  ListAgentsResponse,
  ListRoutinesResponse,
  ListTraceEventsResponse,
  ListTaskCommentsResponse,
  ListTracesResponse,
  ListSkillsResponse,
  ListWorkflowsResponse,
  WorkflowDTO,
  ListTaskEventsResponse,
  ListTasksResponse,
  TaskCountsResponse,
  TaskUsageSummary,
  TaskStatus,
  OpenclawAdapterConfig,
  ChannelDTO,
  ChannelType,
  ChannelUpsertRequest,
  CreateTaskCommentRequest,
  TaskCommentResponse,
  MeResponse,
  PauseCompanyRequest,
  ProbeRequest,
  ProbeResponse,
  HermesProbeRequest,
  RoutineResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
  TraceResponse,
  SkillDTO,
  SkillResponse,
  SyncAgentSkillsRequest,
  SyncAgentToolsRequest,
  TaskResponse,
  UpdateAgentRequest,
  UpdateCompanyRequest,
  UpdateRoutineRequest,
  UpdateTriggerRequest,
  CreateTriggerRequest,
  RoutineTriggerDTO,
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
  // Set / clear the caller's optional display name. `null` clears it.
  updateName: (name: string | null) =>
    request<AuthMeResponse>("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
};

export const adaptersApi = {
  probeOpenclaw: (input: ProbeRequest) =>
    request<ProbeResponse>("/api/adapters/openclaw/probe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  probeHermes: (input: HermesProbeRequest) =>
    request<ProbeResponse>("/api/adapters/hermes/probe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  probeClaudeCode: (input: { model?: string; gatewayUrl?: string; apiKey?: string }) =>
    request<ProbeResponse>("/api/adapters/claude-code/probe", {
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

export interface PrepareSetReceivingAddressRequest {
  receivingAddress: string;
}

export interface PrepareSetReceivingAddressResponse extends PreparedTx {
  receivingAddress: string;
}

export interface ConfirmSetReceivingAddressRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  receivingAddress: string;
}

export interface ConfirmSetReceivingAddressResponse {
  receivingAddress: string;
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
  prepareAgentReceivingAddress: (identityId: string, receivingAddress: string) =>
    request<{
      transaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
      receivingAddress: string;
    }>(`/api/chain/agent-identities/${identityId}/receiving-address/prepare`, {
      method: "POST",
      body: JSON.stringify({ receivingAddress }),
    }),
  confirmAgentReceivingAddress: (
    identityId: string,
    body: {
      signedTransaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
      receivingAddress: string;
    },
  ) =>
    request<{ receivingAddress: string; signature: string }>(
      `/api/chain/agent-identities/${identityId}/receiving-address/confirm`,
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
  prepareSetReceivingAddress: (
    agentId: string,
    body: PrepareSetReceivingAddressRequest,
  ) =>
    request<PrepareSetReceivingAddressResponse>(
      `/api/chain/agents/${agentId}/receiving-address/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmSetReceivingAddress: (
    agentId: string,
    body: ConfirmSetReceivingAddressRequest,
  ) =>
    request<ConfirmSetReceivingAddressResponse>(
      `/api/chain/agents/${agentId}/receiving-address/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getTreasury: (companyId: string) =>
    request<TreasuryStateResponse>(
      `/api/chain/companies/${companyId}/treasury`,
    ),
  prepareSetPolicy: (companyId: string, body: PrepareSetPolicyRequest) =>
    request<PreparedTx>(
      `/api/chain/companies/${companyId}/treasury/policy/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmSetPolicy: (companyId: string, body: ConfirmSetPolicyRequest) =>
    request<{ signature: string }>(
      `/api/chain/companies/${companyId}/treasury/policy/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getPendingDisbursements: (companyId: string) =>
    request<PendingDisbursementsResponse>(
      `/api/chain/companies/${companyId}/disbursements/pending`,
    ),
  prepareDisbursement: (companyId: string) =>
    request<PrepareDisbursementResponse>(
      `/api/chain/companies/${companyId}/disbursements/prepare`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  confirmDisbursement: (companyId: string, body: ConfirmDisbursementRequest) =>
    request<{ signature: string; paidCount: number }>(
      `/api/chain/companies/${companyId}/disbursements/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // ── Operations lifecycle (Disbursement + Anchor wallets) ──────────────
  /** Phase 1: the operator's hot wallet plays the Disbursement + Anchor
   *  signer role. FE pre-fills `signer` in register flows by reading this
   *  endpoint. Returns 503 if the operator keypair isn't configured
   *  server-side. */
  getOperatorPubkey: () =>
    request<{ pubkey: string }>(`/api/chain/operator/pubkey`),
  getOperations: (companyId: string) =>
    request<{ operations: OperationsAccountState[] }>(
      `/api/chain/companies/${companyId}/operations`,
    ),
  prepareRegisterOperations: (
    companyId: string,
    body: RegisterOperationsBody,
  ) =>
    request<PreparedTx>(
      `/api/chain/companies/${companyId}/operations/register/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmRegisterOperations: (
    companyId: string,
    body: ConfirmOperationsBody,
  ) =>
    request<{ signature: string }>(
      `/api/chain/companies/${companyId}/operations/register/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareUpdateOperations: (
    companyId: string,
    body: UpdateOperationsBody,
  ) =>
    request<PreparedTx>(
      `/api/chain/companies/${companyId}/operations/update/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmUpdateOperations: (
    companyId: string,
    body: ConfirmOperationsBody,
  ) =>
    request<{ signature: string }>(
      `/api/chain/companies/${companyId}/operations/update/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareRevokeOperations: (
    companyId: string,
    body: LifecycleOperationsBody,
  ) =>
    request<PreparedTx>(
      `/api/chain/companies/${companyId}/operations/revoke/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmRevokeOperations: (
    companyId: string,
    body: ConfirmOperationsBody,
  ) =>
    request<{ signature: string }>(
      `/api/chain/companies/${companyId}/operations/revoke/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  prepareCloseOperations: (
    companyId: string,
    body: LifecycleOperationsBody,
  ) =>
    request<PreparedTx>(
      `/api/chain/companies/${companyId}/operations/close/prepare`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirmCloseOperations: (
    companyId: string,
    body: ConfirmOperationsBody,
  ) =>
    request<{ signature: string }>(
      `/api/chain/companies/${companyId}/operations/close/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // ── Routine payouts (autonomous, no wallet popup) ─────────────────────
  runRoutinePayouts: (companyId: string) =>
    request<RoutinePayoutSummary>(
      `/api/chain/companies/${companyId}/payouts/run`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  // ── Daily anchors (read-only) ─────────────────────────────────────────
  getCompanyAnchors: (companyId: string) =>
    request<{ anchors: DailyAnchorRecord[] }>(
      `/api/chain/companies/${companyId}/anchors`,
    ),
  // ── Trace anchors / per-deliverable provenance (read-only) ────────────
  getCompanyTraceAnchors: (companyId: string) =>
    request<{ traces: TraceAnchorRecord[] }>(
      `/api/chain/companies/${companyId}/trace-anchors`,
    ),
  // ── Company-wide tx list (read-only) ──────────────────────────────────
  getCompanyTransactions: (
    companyId: string,
    params?: { limit?: number; before?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.before) qs.set("before", params.before);
    const query = qs.toString();
    return request<CompanyTransactionsResponse>(
      `/api/chain/companies/${companyId}/transactions${query ? `?${query}` : ""}`,
    );
  },
};

export interface CompanyTransactionRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  action: string | null;
  err: string | null;
  signer: string | null;
}

export interface CompanyTransactionsResponse {
  records: CompanyTransactionRecord[];
  hasMore: boolean;
}

export interface DailyAnchorRecord {
  pda: string;
  deploymentPda: string;
  agentName: string | null;
  agentRole: string | null;
  dayUnix: number;
  merkleRoot: string;
  taskCount: number;
  committedAt: number;
  committedBy: string;
}

export interface TraceAnchorRecord {
  pda: string;
  taskId: string;
  company: string;
  agent: string;
  deployment: string;
  agentName: string | null;
  agentRole: string | null;
  resultUri: string;
  contentHash: string;
  verdict: number;
  qualityScore: number;
  rubricVersion: number;
  evidenceHash: string;
  completedAt: number;
  committedAt: number;
  committedBy: string;
}

// ── Operations + payouts request/response shapes ─────────────────────────

export type OperationsKindString = "disbursement" | "anchor";

export interface OperationsAccountState {
  /** 0 = Disbursement, 1 = Anchor (matches OPERATIONS_KIND in occa-sdk). */
  kind: 0 | 1;
  pda: string;
  exists: boolean;
  signer: string | null;
  /** Hex-encoded 8-byte Anchor discriminators (no 0x prefix). */
  actionWhitelist: string[];
  rateLimitPerPeriod: number;
  signaturesThisPeriod: number;
  /** Unix seconds as string (avoids JSON bigint loss). */
  currentPeriodAnchor: string;
  expiryUnix: string;
  revoked: boolean;
}

export interface RegisterOperationsBody {
  kind: OperationsKindString;
  signer: string;
  actionWhitelist: string[];
  rateLimitPerPeriod: number;
  expiryUnix: number;
}

export interface UpdateOperationsBody {
  kind: OperationsKindString;
  actionWhitelist?: string[];
  rateLimitPerPeriod?: number;
  expiryUnix?: number;
}

export interface LifecycleOperationsBody {
  kind: OperationsKindString;
}

export interface ConfirmOperationsBody {
  kind: OperationsKindString;
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface RoutinePayoutResult {
  deploymentId: string;
  agentName: string;
  invoiceIds: string[];
  totalLamports: number;
  signature: string | null;
  error: string | null;
}

export interface RoutinePayoutSummary {
  paidLamports: number;
  paidInvoiceCount: number;
  failureCount: number;
  results: RoutinePayoutResult[];
}

export interface DisbursementPayableAgent {
  deploymentId: string;
  agentName: string;
  receivingAddress: string;
  invoiceCount: number;
  totalLamports: number;
}

export interface DisbursementBlockedAgent {
  deploymentId: string;
  agentName: string;
  invoiceCount: number;
  totalLamports: number;
}

export interface PendingDisbursementsResponse {
  payable: DisbursementPayableAgent[];
  blocked: DisbursementBlockedAgent[];
  totalLamports: number;
  estimatedFeeLamports: number;
  feeBps: number;
  treasuryBalanceLamports: number;
  /** Minimum balance the Treasury PDA must keep to stay rent-exempt.
   *  Disbursements that would drop balance below this revert on-chain
   *  (`InsufficientFunds` 6025). */
  rentExemptMinLamports: number;
  /** balance - rentExemptMin. What's actually disbursable right now. */
  usableBalanceLamports: number;
  /** Lamports as a string — JSON can't carry bigint. */
  budgetRemainingLamports: string;
}

export interface PrepareDisbursementResponse extends PreparedTx {
  /** Every invoice the prepared tx settles — passed back on confirm. */
  invoiceIds: string[];
}

export interface ConfirmDisbursementRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  invoiceIds: string[];
}

export interface TreasuryStateResponse {
  treasuryPda: string;
  policyPda: string;
  balanceLamports: number;
  initialized: boolean;
  /** Lamports as a string — JSON can't carry bigint. */
  routineBudgetLamports: string;
  routineSpentLamports: string;
  discretionaryBudgetLamports: string;
  discretionarySpentLamports: string;
  agentOperatingFeeBps: number;
}

export interface PrepareSetPolicyRequest {
  routineBudgetLamports: number;
  discretionaryBudgetLamports: number;
}

export interface ConfirmSetPolicyRequest {
  signedTransaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface CreateCompanyRequest {
  name: string;
}

export const companiesApi = {
  get: (id: string) => request<CompanyResponse>(`/api/companies/${id}`),
  create: (input: CreateCompanyRequest) =>
    request<CompanyResponse>("/api/companies", {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
  list: (opts?: {
    includeArchived?: boolean;
    archivedOnly?: boolean;
    status?: TaskStatus;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.includeArchived) qs.set("include_archived", "1");
    if (opts?.archivedOnly) qs.set("archived", "1");
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<ListTasksResponse>(`/api/tasks${suffix}`);
  },
  counts: () => request<TaskCountsResponse>("/api/tasks/counts"),
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
  usage: (id: string) =>
    request<TaskUsageSummary>(`/api/tasks/${id}/usage`),
  archive: (id: string, input: { reason?: string }) =>
    request<TaskResponse>(`/api/tasks/${id}/archive`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unarchive: (id: string) =>
    request<TaskResponse>(`/api/tasks/${id}/unarchive`, { method: "POST" }),
};

// One past/current chat session (thread reset_generation).
export interface ChatSessionSummary {
  generation: number;
  messageCount: number;
  startedAt: string;
  lastAt: string;
}
export interface ListChatSessionsResponse {
  sessions: ChatSessionSummary[];
  currentGeneration: number;
}

export const chatApi = {
  ceo: {
    list: () => request<ListChatMessagesResponse>("/api/chat/ceo"),
    listAt: (generation: number) =>
      request<ListChatMessagesResponse>(`/api/chat/ceo?generation=${generation}`),
    sessions: () => request<ListChatSessionsResponse>("/api/chat/ceo/sessions"),
    send: (input: SendChatMessageRequest) =>
      request<SendChatMessageResponse>("/api/chat/ceo", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    // "New session" — server bumps the thread generation (prior messages
    // kept for History) and resets the gateway-side memory.
    clear: () =>
      request<void>("/api/chat/ceo", {
        method: "DELETE",
      }),
  },
  // Per-agent direct chat (user ↔ an owned agent). Same wire shapes as the
  // CEO surface, scoped to a deployment id. The server gates this on
  // identity ownership.
  agent: (deploymentId: string) => ({
    list: () =>
      request<ListChatMessagesResponse>(`/api/chat/agent/${deploymentId}`),
    listAt: (generation: number) =>
      request<ListChatMessagesResponse>(
        `/api/chat/agent/${deploymentId}?generation=${generation}`,
      ),
    sessions: () =>
      request<ListChatSessionsResponse>(
        `/api/chat/agent/${deploymentId}/sessions`,
      ),
    send: (input: SendChatMessageRequest) =>
      request<SendChatMessageResponse>(`/api/chat/agent/${deploymentId}`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    clear: () =>
      request<void>(`/api/chat/agent/${deploymentId}`, {
        method: "DELETE",
      }),
  }),
};

export interface BrainFileDTO {
  id: string;
  path: string;
  content: string;
  visibility: "all" | "ceo_only" | "tier:head";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateBrainFileRequest {
  path: string;
  content: string;
  visibility: "all" | "ceo_only" | "tier:head";
}
export interface UpdateBrainFileRequest {
  content?: string;
  visibility?: "all" | "ceo_only" | "tier:head";
}
export const companyBrainApi = {
  list: () =>
    request<{ files: BrainFileDTO[] }>("/api/company-brain"),
  create: (input: CreateBrainFileRequest) =>
    request<{ file: BrainFileDTO }>("/api/company-brain", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: UpdateBrainFileRequest) =>
    request<{ file: BrainFileDTO }>(`/api/company-brain/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<void>(`/api/company-brain/${id}`, { method: "DELETE" }),
};

export interface DocumentDTO {
  id: string;
  taskId: string | null;
  deploymentId: string | null;
  title: string;
  content: string;
  format: string;
  tags: string[];
  createdAt: string;
}
export interface DocumentFolderDTO {
  id: string;
  label: string;
  count: number;
}
export interface DocumentFoldersResponse {
  folders: DocumentFolderDTO[];
  total: number;
  untagged: number;
}
export const documentsApi = {
  list: (opts?: {
    tags?: string[];
    untagged?: boolean;
    day?: string;
    tz?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.tags && opts.tags.length > 0) qs.set("tags", opts.tags.join(","));
    if (opts?.untagged) qs.set("untagged", "1");
    if (opts?.day) qs.set("day", opts.day);
    if (opts?.tz) qs.set("tz", opts.tz);
    if (opts?.search) qs.set("search", opts.search);
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ documents: DocumentDTO[]; hasMore?: boolean }>(
      `/api/documents${suffix}`,
    );
  },
  folders: (axis: "date" | "tags", tz?: string) => {
    const qs = new URLSearchParams({ axis });
    if (tz) qs.set("tz", tz);
    return request<DocumentFoldersResponse>(`/api/documents/folders?${qs.toString()}`);
  },
  get: (id: string) =>
    request<{ document: DocumentDTO }>(`/api/documents/${id}`),
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
  refresh: (id: string) =>
    request<{ updated: boolean; sourceRef: string; skill: SkillDTO }>(
      `/api/skills/${id}/refresh`,
      { method: "POST" },
    ),
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
  pause: (id: string) =>
    request<AgentResponse>(`/api/agents/${id}/pause`, { method: "POST" }),
  activate: (id: string) =>
    request<AgentResponse>(`/api/agents/${id}/activate`, { method: "POST" }),
  setAvailability: (id: string, available: boolean) =>
    request<AgentResponse>(`/api/agents/${id}/availability`, {
      method: "POST",
      body: JSON.stringify({ available }),
    }),
  rotateBearer: (id: string, apiKey: string) =>
    request<{ ok: boolean; latencyMs: number }>(
      `/api/agents/${id}/adapter/rotate-bearer`,
      { method: "POST", body: JSON.stringify({ apiKey }) },
    ),
  switchAdapter: (
    id: string,
    input:
      | {
          adapterType: "openclaw" | "hermes";
          adapterConfig: { gatewayUrl: string; apiKey: string };
        }
      | {
          adapterType: "claude-code";
          adapterConfig: { model?: string };
        },
  ) =>
    request<AgentResponse>(`/api/agents/${id}/adapter/switch`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  syncSkills: (id: string, input: SyncAgentSkillsRequest) =>
    request<AgentResponse>(`/api/agents/${id}/skills/sync`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  syncTools: (id: string, input: SyncAgentToolsRequest) =>
    request<AgentResponse>(`/api/agents/${id}/tools/sync`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  files: (id: string) =>
    request<ListAgentFilesResponse>(`/api/agents/${id}/files`),
  listChannels: (id: string) =>
    request<{ channels: ChannelDTO[] }>(`/api/agents/${id}/channels`),
  upsertChannel: (
    id: string,
    channelType: ChannelType,
    input: ChannelUpsertRequest,
  ) =>
    request<{ channel: ChannelDTO }>(
      `/api/agents/${id}/channels/${channelType}`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  deleteChannel: (id: string, channelType: ChannelType) =>
    request<void>(`/api/agents/${id}/channels/${channelType}`, {
      method: "DELETE",
    }),
  testNotifyChannel: (id: string, channelType: ChannelType) =>
    request<{ ok: true; info: Record<string, unknown> }>(
      `/api/agents/${id}/channels/${channelType}/test-notify`,
      { method: "POST" },
    ),
  simulateNotification: (id: string, kind: string) =>
    request<{ ok: true; notificationId: string }>(
      `/api/agents/${id}/notifications/simulate`,
      { method: "POST", body: JSON.stringify({ kind }) },
    ),
  updateFile: (id: string, filename: string, input: UpdateAgentFileRequest) =>
    request<UpdateAgentFileResponse>(
      `/api/agents/${id}/files/${encodeURIComponent(filename)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
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

export const marketplaceApi = {
  listAgents: () =>
    request<MarketplaceAgentsResponse>("/api/marketplace/agents"),
  createInvite: (targetIdentityId: string, role: string) =>
    request<{ inviteId: string }>("/api/marketplace/invites", {
      method: "POST",
      body: JSON.stringify({ targetIdentityId, role }),
    }),
  listIncomingInvites: () =>
    request<MarketplaceInvitesResponse>("/api/marketplace/invites/incoming"),
  listOutgoingInvites: () =>
    request<MarketplaceInvitesResponse>("/api/marketplace/invites/outgoing"),
  rejectInvite: (id: string) =>
    request<{ ok: boolean }>(`/api/marketplace/invites/${id}/reject`, {
      method: "POST",
    }),
  prepareAcceptInvite: (id: string) =>
    request<{
      transaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
      deploymentIndex: number;
    }>(`/api/marketplace/invites/${id}/accept/prepare`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  confirmAcceptInvite: (
    id: string,
    body: {
      signedTransaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
      deploymentIndex: number;
    },
  ) =>
    request<{ deploymentId: string; signature: string }>(
      `/api/marketplace/invites/${id}/accept/confirm`,
      { method: "POST", body: JSON.stringify(body) },
    ),
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

interface WorkflowEnvelope {
  workflow: WorkflowDTO;
}

export const workflowsApi = {
  list: () => request<ListWorkflowsResponse>("/api/workflows"),
  get: (id: string) => request<WorkflowEnvelope>(`/api/workflows/${id}`),
  create: (input: { yamlText: string; enabled?: boolean }) =>
    request<WorkflowEnvelope>("/api/workflows", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (id: string, input: { yamlText?: string; enabled?: boolean }) =>
    request<WorkflowEnvelope>(`/api/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<void>(`/api/workflows/${id}`, { method: "DELETE" }),
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
  run: (id: string) =>
    request<{ ok: boolean }>(`/api/routines/${id}/run`, { method: "POST" }),
  patchTrigger: (
    routineId: string,
    triggerId: string,
    input: UpdateTriggerRequest,
  ) =>
    request<{ trigger: RoutineTriggerDTO }>(
      `/api/routines/${routineId}/triggers/${triggerId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  createTrigger: (routineId: string, input: CreateTriggerRequest) =>
    request<{ trigger: RoutineTriggerDTO }>(
      `/api/routines/${routineId}/triggers`,
      { method: "POST", body: JSON.stringify(input) },
    ),
};

export interface DevSeedApprovalResponse {
  ok: boolean;
  approvalId: string;
}

export const devApi = {
  seedApproval: () =>
    request<DevSeedApprovalResponse>("/api/dev/seed-approval", {
      method: "POST",
    }),
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
  dismiss: (id: string) =>
    request<DismissApprovalResponse>(`/api/approvals/${id}/dismiss`, {
      method: "POST",
    }),
};

export const notificationsApi = {
  list: (opts?: { unread?: boolean; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.unread) qs.set("unread", "1");
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<import("@occa/shared/types").ListNotificationsResponse>(
      `/api/notifications${suffix}`,
    );
  },
  markRead: (id: string) =>
    request<import("@occa/shared/types").NotificationActionResponse>(
      `/api/notifications/${id}/read`,
      { method: "POST" },
    ),
  dismiss: (id: string) =>
    request<import("@occa/shared/types").NotificationActionResponse>(
      `/api/notifications/${id}/dismiss`,
      { method: "POST" },
    ),
  readAll: () =>
    request<{ updated: number }>(`/api/notifications/read-all`, {
      method: "POST",
    }),
};

export const toolsApi = {
  // Operator-facing
  catalog: () =>
    request<import("@occa/shared/types").ToolCatalogResponse>(
      "/api/tool-catalog",
    ),
  list: (companyId: string) =>
    request<import("@occa/shared/types").ListCompanyToolsResponse>(
      `/api/companies/${companyId}/tools`,
    ),
  install: (
    companyId: string,
    input: import("@occa/shared/types").InstallCompanyToolRequest,
  ) =>
    request<import("@occa/shared/types").CompanyToolResponse>(
      `/api/companies/${companyId}/tools`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  patch: (
    companyId: string,
    toolId: string,
    input: import("@occa/shared/types").UpdateCompanyToolRequest,
  ) =>
    request<import("@occa/shared/types").CompanyToolResponse>(
      `/api/companies/${companyId}/tools/${toolId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  remove: (companyId: string, toolId: string) =>
    request<{ ok: boolean }>(
      `/api/companies/${companyId}/tools/${toolId}`,
      { method: "DELETE" },
    ),
  test: (companyId: string, toolId: string) =>
    request<import("@occa/shared/types").TestCompanyToolResponse>(
      `/api/companies/${companyId}/tools/${toolId}/test`,
      { method: "POST" },
    ),
  logs: (
    companyId: string,
    toolId: string,
    opts?: { limit?: number; before?: string },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<import("@occa/shared/types").ListToolCallLogsResponse>(
      `/api/companies/${companyId}/tools/${toolId}/logs${suffix}`,
    );
  },
};

export const webhooksApi = {
  list: (companyId: string) =>
    request<import("@occa/shared/types").ListWebhooksResponse>(
      `/api/companies/${companyId}/webhooks`,
    ),
  create: (
    companyId: string,
    input: import("@occa/shared/types").CreateWebhookRequest,
  ) =>
    request<import("@occa/shared/types").WebhookResponse>(
      `/api/companies/${companyId}/webhooks`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  update: (
    companyId: string,
    webhookId: string,
    input: import("@occa/shared/types").UpdateWebhookRequest,
  ) =>
    request<import("@occa/shared/types").WebhookResponse>(
      `/api/companies/${companyId}/webhooks/${webhookId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  remove: (companyId: string, webhookId: string) =>
    request<void>(`/api/companies/${companyId}/webhooks/${webhookId}`, {
      method: "DELETE",
    }),
  test: (companyId: string, webhookId: string) =>
    request<import("@occa/shared/types").WebhookTestResponse>(
      `/api/companies/${companyId}/webhooks/${webhookId}/test`,
      { method: "POST" },
    ),
};
