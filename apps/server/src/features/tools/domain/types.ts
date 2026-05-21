// Tool handler contract.
//
// Each external service OCCA ships (X, Notion, Shopify, MCP, ...) is one
// handler module exporting a `ToolHandler`. The handler declares:
//
//   - its type slug (matches `company_tools.type`)
//   - a Zod schema for its credentials (used by the install UI form, by
//     credential validation at install time, and by the typed payload
//     handlers receive at invoke time)
//   - the set of actions the tool exposes, each with input + output
//     schemas and an `invoke` function
//
// Handlers with dynamic action sets (MCP, where actions are discovered
// by introspecting the remote server) declare `resolveActions` instead
// of a static `actions` map. The registry surfaces both forms uniformly.

import type { ZodSchema } from "zod";

export interface ToolAction {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  outputSchema: ZodSchema;
  invoke: (
    ctx: ToolInvokeContext,
    input: unknown,
  ) => Promise<ToolInvokeResult>;
}

// UI-facing description of one input field. Generated alongside the Zod
// schema so the install form can render itself without introspection.
export interface ToolFieldHint {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  secret: boolean;
  description?: string;
}

export interface ToolHandler {
  type: string;
  displayName: string;
  description: string;
  // Plaintext shape of the credentials this tool accepts. The UI renders
  // the install form from this; the route layer validates submitted
  // credentials against this before encrypting + storing.
  credentialsSchema: ZodSchema;
  // UI form descriptors for credentials. Mirror credentialsSchema field
  // by field; the UI uses these to render labels, secret-masking, and
  // required indicators without poking at Zod internals.
  credentialFields: ToolFieldHint[];
  // Optional per-handler non-secret config (MCP url, default workspace,
  // OAuth scopes, etc.). Validated separately from credentials.
  metadataSchema?: ZodSchema;
  // Same role as credentialFields, for metadata.
  metadataFields?: ToolFieldHint[];
  // Static action map. Mutually exclusive with `resolveActions`.
  actions?: Record<string, ToolAction>;
  // Dynamic action discovery, called when the handler is invoked or when
  // the operator UI refreshes the action list. Used by the MCP handler.
  resolveActions?: (args: {
    credentials: unknown;
    metadata: unknown;
  }) => Promise<Record<string, ToolAction>>;
  // Optional connection test. If present, the operator UI offers a
  // "Test connection" button on the install form.
  testConnection?: (args: {
    credentials: unknown;
    metadata: unknown;
  }) => Promise<ToolConnectionTestResult>;
}

export interface ToolInvokeContext {
  // Plaintext credentials, already decrypted and validated against the
  // handler's `credentialsSchema`.
  credentials: unknown;
  // Validated non-secret tool metadata.
  metadata: unknown;
  // Scope identifiers — handlers should never reach beyond these.
  companyId: string;
  toolId: string;
  // The deployment that initiated the call. Null when invoked by an
  // operator action (e.g. test-from-UI).
  deploymentId: string | null;
}

export type ToolInvokeResult =
  | {
      ok: true;
      // The validated output, conforming to the action's `outputSchema`.
      output: unknown;
      // Optional small summary to persist in `tool_call_logs.result_summary`.
      // Defaults to `output` if omitted, but handlers should provide
      // a trimmed version when `output` contains heavy payloads.
      resultSummary?: Record<string, unknown>;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      // Set to "rate_limited" when the upstream service returned 429 or
      // equivalent — the route layer surfaces this as a different log
      // status so operators can spot rate-limit incidents distinctly.
      rateLimited?: boolean;
    };

export type ToolConnectionTestResult =
  | { ok: true; detail?: string }
  | { ok: false; errorCode: string; errorMessage: string };
