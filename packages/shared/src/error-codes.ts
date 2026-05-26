// Canonical inventory of error codes returned by the OCCA HTTP API.
// Server emits these as `{ error: ERROR_CODES.X }`; web consumes by string
// equality (some sites already do, others can migrate gradually).
//
// String values must remain stable — they are part of the API contract.
// Renaming a constant is fine, changing its string value is a breaking
// change for any web client comparing against the literal.

export const ERROR_CODES = {
  // Generic
  NOT_FOUND: "not_found",
  INVALID_BODY: "invalid_body",
  INVALID_QUERY: "invalid_query",
  INTERNAL_ERROR: "internal_error",
  UPSTREAM_FAILED: "upstream_failed",
  SERVER_RESTART: "server_restart",

  // Auth
  USER_NOT_FOUND: "user_not_found",
  SIGNATURE_INVALID: "signature_invalid",
  NONCE_INVALID_OR_EXPIRED: "nonce_invalid_or_expired",
  NONCE_ALREADY_USED: "nonce_already_used",
  INVALID_TOKEN: "invalid_token",
  MISSING_TOKEN: "missing_token",
  INVALID_AGENT_TOKEN: "invalid_agent_token",
  FORBIDDEN: "forbidden",
  DEV_WALLET_NOT_CONFIGURED: "dev_wallet_not_configured",
  PRIVY_TOKEN_INVALID: "privy_token_invalid",
  PRIVY_NO_SOLANA_WALLET: "privy_no_solana_wallet",
  PRIVY_NOT_CONFIGURED: "privy_not_configured",

  // Company
  NO_COMPANY: "no_company",
  COMPANY_REQUIRED: "company_required",
  COMPANY_NOT_FOUND: "company_not_found",
  COMPANY_PAUSED: "company_paused",
  COMPANY_ALREADY_EXISTS: "company_already_exists",
  NO_ROLES_SELECTED: "no_roles_selected",
  TOO_MANY_ROLES: "too_many_roles",

  // Agent
  AGENT_NOT_FOUND: "agent_not_found",
  AGENT_NOT_CONFIGURED: "agent_not_configured",
  AGENT_NOT_PROVISIONED: "agent_not_provisioned",
  NO_AGENT_ASSIGNED: "no_agent_assigned",
  NO_AGENT_CREDS_AVAILABLE: "no_agent_creds_available",
  /** Hierarchical agent system (Phase 2): user-created top-level tasks must
   *  route through a `tier:"ceo"` deployment. Returned when the company
   *  has no active CEO — user must deploy one before creating tasks. */
  NO_CEO_DEPLOYED: "no_ceo_deployed",
  HIRE_NOT_ALLOWED: "hire_not_allowed",
  WOULD_CREATE_CYCLE: "would_create_cycle",
  ROLE_NOT_ALLOWED: "role_not_allowed",
  PARENT_NOT_IN_COMPANY: "parent_not_in_company",
  // Seat / workstation
  WORKSTATION_NOT_FOUND: "workstation_not_found",
  WORKSTATION_OCCUPIED: "workstation_occupied",

  // Token
  TOKEN_NOT_FOUND: "token_not_found",

  // Task
  TASK_NOT_FOUND: "task_not_found",
  TASK_LOCKED: "task_locked",
  TASK_ARCHIVED: "task_archived",
  TASK_NOT_ARCHIVED: "task_not_archived",
  TASK_REASSIGN_DISABLED: "task_reassign_disabled",
  INVALID_STATUS_TRANSITION: "invalid_status_transition",
  COMMENT_FAILED: "comment_failed",

  // Trace
  TRACE_NOT_FOUND: "trace_not_found",
  TRACE_NOT_CANCELLABLE: "trace_not_cancellable",
  BUILD_FRAME_FAILED: "build_frame_failed",

  // Approval
  APPROVAL_NOT_FOUND: "approval_not_found",
  APPROVAL_ALREADY_DECIDED: "approval_already_decided",
  REJECTION_REASON_REQUIRED: "rejection_reason_required",
  SIDE_EFFECT_FAILED: "side_effect_failed",
  UNSUPPORTED_ACTION_TYPE: "unsupported_action_type",

  // Notification
  NOTIFICATION_NOT_FOUND: "notification_not_found",

  // Agent action HTTP back-channel (POST /api/agents/me/actions/emit)
  TASK_DEPTH_EXCEEDED: "task_depth_exceeded",
  TASK_CHILDREN_EXCEEDED: "task_children_exceeded",
  TASK_NOT_IN_COMPANY: "task_not_in_company",

  // Routine
  TRIGGER_NOT_FOUND: "trigger_not_found",
  CRON_REQUIRED: "cron_required",
  INVALID_CRON_EXPRESSION: "invalid_cron_expression",

  // Skill
  SKILL_NOT_FOUND: "skill_not_found",
  SKILL_NOT_ASSIGNED: "skill_not_assigned",
  UNKNOWN_SKILL_KEYS: "unknown_skill_keys",
  BUILTIN_READONLY: "builtin_readonly",

  // Workspace files
  FILE_NOT_IN_INVENTORY: "file_not_in_inventory",
  MISSING_PATH: "missing_path",
  WORKSPACE_SEED_FAILED: "workspace_seed_failed",
  WORKSPACE_FILES_RPC_UNAVAILABLE: "workspace_files_rpc_unavailable",

  // Tools primitive
  TOOL_NOT_FOUND: "tool_not_found",
  TOOL_TYPE_UNKNOWN: "tool_type_unknown",
  TOOL_ACTION_NOT_FOUND: "tool_action_not_found",
  TOOL_PAUSED: "tool_paused",
  TOOL_DUPLICATE_LABEL: "tool_duplicate_label",
  TOOL_INVOCATION_FAILED: "tool_invocation_failed",
  UNKNOWN_TOOL_IDS: "unknown_tool_ids",
  INVALID_CREDENTIALS: "invalid_credentials",

  // Adapter / OpenClaw gateway
  GATEWAY_UNREACHABLE: "gateway_unreachable",
  GATEWAY_UNAUTHORIZED: "gateway_unauthorized",
  GATEWAY_PROVISION_FAILED: "gateway_provision_failed",
  GATEWAY_LIST_FAILED: "gateway_list_failed",
  DEVICE_PAIRING_REQUIRED: "device_pairing_required",
  OPENCLAW_AGENT_ID_CONFLICT: "openclaw_agent_id_conflict",

  // Workflow (Phase 5 storage; Phase 6 engine adds runtime errors)
  WORKFLOW_NOT_FOUND: "workflow_not_found",
  WORKFLOW_YAML_INVALID: "workflow_yaml_invalid",
  WORKFLOW_ID_CONFLICT: "workflow_id_conflict",

  // Company Brain
  BRAIN_PATH_CONFLICT: "brain_path_conflict",

  // On-chain Registry
  ALREADY_REGISTERED: "already_registered",
  CHAIN_TX_FAILED: "chain_tx_failed",
  OPERATOR_NOT_CONFIGURED: "operator_not_configured",
  /** Caller's prerequisite chain accounts (company / CEO identity) are
   *  still placeholders. Triggered by the kickoff guard so a user can't
   *  start hiring before onboarding's anchor flow has completed. */
  CHAIN_NOT_ANCHORED: "chain_not_anchored",
  /** A disbursement run was requested with no payable pending invoices. */
  NOTHING_TO_DISBURSE: "nothing_to_disburse",
  /** Too many agents in one disbursement batch to fit a single Solana tx. */
  DISBURSEMENT_BATCH_TOO_LARGE: "disbursement_batch_too_large",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
