// Operator-facing routes for managing a company's installed tools.
// Mounted under /api/companies/:companyId/tools. Uses mergeParams so the
// inner handlers can read `req.params.companyId` from the parent URL.
//
// Endpoints:
//   GET    /                      list tools for the company
//   POST   /                      install a new tool
//   PATCH  /:toolId               update label / credentials / metadata / status
//   DELETE /:toolId               uninstall
//   POST   /:toolId/test          run handler.testConnection
//   GET    /:toolId/logs          recent invocations
//
// Ownership: every handler resolves the parent company via the auth user
// before doing anything, so a user can't manipulate another company's
// tools by guessing IDs.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";
import { requireAuth } from "../../../middleware/auth";
import { findOwnedById as findOwnedCompanyById } from "../../companies/repositories/companies";
import { findCatalogEntry, listCatalog } from "../services/catalog-loader";
import { findEmbeddedHandler } from "../handlers/embedded-handlers";
import { testMcpConnection } from "../handlers/mcp";
import {
  credentialsSchemaFor,
  metadataSchemaFor,
} from "../services/credential-validator";
import type { CatalogEntry } from "../domain/catalog-schemas";
import {
  encryptCredentials,
} from "../../../lib/tool-crypto";
import type { EncryptedBlob } from "../../../lib/tool-crypto";
import {
  installToolBody,
  listToolLogsQuery,
  updateToolBody,
} from "../domain/schemas";
import {
  broadcastToolToEligibleAgents,
  findOwnedById as findOwnedToolById,
  insert as insertCompanyTool,
  listForCompany,
  purgeToolFromEnabledLists,
  updateById as updateCompanyTool,
  deleteById as deleteCompanyTool,
} from "../repositories/company-tools";
import { listForTool } from "../repositories/tool-call-logs";
import {
  log,
  toCompanyToolDTOSync,
  toToolCallLogDTO,
} from "./_shared";
import type {
  CompanyToolResponse,
  ListCompanyToolsResponse,
  ListToolCallLogsResponse,
  TestCompanyToolResponse,
  ToolTestConnectionResult,
} from "@occa/shared/types";

const router: Router = Router({ mergeParams: true });

// Run testConnection for a tool — dispatches on the catalog entry's
// implementation kind. Returns a typed result the caller can drop into
// the install/test response body directly.
async function runTestConnection(args: {
  entry: CatalogEntry;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<ToolTestConnectionResult> {
  if (args.entry.implementation.kind === "embedded") {
    const handler = findEmbeddedHandler(args.entry.implementation.handler);
    if (!handler || !handler.testConnection) {
      return {
        ok: false,
        errorCode: "not_supported",
        errorMessage: `Embedded handler "${args.entry.implementation.handler}" has no testConnection.`,
      };
    }
    try {
      return await handler.testConnection({
        credentials: args.credentials,
        metadata: args.metadata,
      });
    } catch (err) {
      return {
        ok: false,
        errorCode: "test_connection_failed",
        errorMessage:
          err instanceof Error ? err.message : "testConnection threw",
      };
    }
  }
  // MCP-backed: ping via tools/list as liveness probe.
  return testMcpConnection(args.entry, args.credentials, args.metadata);
}

async function resolveOwnedCompanyId(
  req: Request,
): Promise<string | null> {
  const companyId =
    (req.params as Record<string, string | undefined>).companyId ??
    (req.params as Record<string, string | undefined>).id ??
    null;
  if (!companyId) return null;
  const company = await findOwnedCompanyById({
    userId: req.user!.userId,
    companyId,
  });
  return company?.id ?? null;
}

async function loadCatalogDict(): Promise<Map<string, CatalogEntry>> {
  const entries = await listCatalog();
  return new Map(entries.map((e) => [e.type, e]));
}

// GET /
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompanyId(req);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }
  const [rows, dict] = await Promise.all([
    listForCompany(companyId),
    loadCatalogDict(),
  ]);
  const body: ListCompanyToolsResponse = {
    tools: rows.map((r) => toCompanyToolDTOSync(r, dict)),
  };
  res.json(body);
});

// POST /
router.post("/", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompanyId(req);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }

  const parsed = installToolBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const entry = await findCatalogEntry(parsed.data.type);
  if (!entry) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.TOOL_TYPE_UNKNOWN });
    return;
  }

  const credSchema = credentialsSchemaFor(entry);
  const credResult = credSchema.safeParse(parsed.data.credentials);
  if (!credResult.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_CREDENTIALS,
      detail: credResult.error.flatten(),
    });
    return;
  }

  const metaSchema = metadataSchemaFor(entry);
  const metaResult = metaSchema.safeParse(parsed.data.metadata ?? {});
  if (!metaResult.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: ERROR_CODES.INVALID_BODY,
      detail: metaResult.error.flatten(),
    });
    return;
  }
  const metadata = metaResult.data as Record<string, unknown>;

  let encryptedBlob: EncryptedBlob;
  try {
    encryptedBlob = encryptCredentials(credResult.data);
  } catch (err) {
    log.error({ err }, "tool install: encrypt failed");
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_CODES.INTERNAL_ERROR });
    return;
  }

  const allowedRoles = Array.from(new Set(parsed.data.allowedRoles ?? []));

  let row;
  try {
    row = await insertCompanyTool({
      companyId,
      type: parsed.data.type,
      label: parsed.data.label,
      credentialsEncrypted: encryptedBlob,
      metadata,
      allowedRoles,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
      res
        .status(StatusCodes.CONFLICT)
        .json({ error: ERROR_CODES.TOOL_DUPLICATE_LABEL });
      return;
    }
    throw err;
  }

  // Auto-broadcast to every role-matching deployment in the company.
  // Empty allowedRoles = visible to all roles. Mirrors the skill import
  // flow so operators get one model for both primitives.
  await broadcastToolToEligibleAgents({
    companyId,
    toolId: row.id,
    allowedRoles,
  });

  const body: CompanyToolResponse = {
    tool: toCompanyToolDTOSync(row, new Map([[entry.type, entry]])),
  };

  if (parsed.data.testAfterInstall && entry.hasTestConnection) {
    body.testConnection = await runTestConnection({
      entry,
      credentials: credResult.data as Record<string, unknown>,
      metadata,
    });
  }

  res.status(StatusCodes.CREATED).json(body);
});

// PATCH /:toolId
router.patch("/:toolId", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompanyId(req);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }

  const existing = await findOwnedToolById({ id: req.params.toolId, companyId });
  if (!existing) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TOOL_NOT_FOUND });
    return;
  }

  const parsed = updateToolBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_BODY, detail: parsed.error.flatten() });
    return;
  }

  const entry = await findCatalogEntry(existing.type);
  if (!entry) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.TOOL_TYPE_UNKNOWN });
    return;
  }

  const patch: Parameters<typeof updateCompanyTool>[0]["patch"] = {};

  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.allowedRoles !== undefined) {
    patch.allowedRoles = Array.from(new Set(parsed.data.allowedRoles));
  }

  if (parsed.data.credentials !== undefined) {
    const credResult = credentialsSchemaFor(entry).safeParse(
      parsed.data.credentials,
    );
    if (!credResult.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_CREDENTIALS,
        detail: credResult.error.flatten(),
      });
      return;
    }
    try {
      patch.credentialsEncrypted = encryptCredentials(credResult.data);
    } catch (err) {
      log.error({ err }, "tool patch: encrypt failed");
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }
  }

  if (parsed.data.metadata !== undefined) {
    const metaResult = metadataSchemaFor(entry).safeParse(parsed.data.metadata);
    if (!metaResult.success) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: ERROR_CODES.INVALID_BODY,
        detail: metaResult.error.flatten(),
      });
      return;
    }
    patch.metadata = metaResult.data as Record<string, unknown>;
  }

  if (Object.keys(patch).length > 0) patch.lastError = null;

  const updated = await updateCompanyTool({
    id: existing.id,
    companyId,
    patch,
  });
  if (!updated) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TOOL_NOT_FOUND });
    return;
  }

  const body: CompanyToolResponse = {
    tool: toCompanyToolDTOSync(updated, new Map([[entry.type, entry]])),
  };
  res.json(body);
});

// DELETE /:toolId
router.delete("/:toolId", requireAuth, async (req: Request, res: Response) => {
  const companyId = await resolveOwnedCompanyId(req);
  if (!companyId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
    return;
  }

  await purgeToolFromEnabledLists({ companyId, toolId: req.params.toolId });
  const ok = await deleteCompanyTool({ id: req.params.toolId, companyId });
  if (!ok) {
    res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.TOOL_NOT_FOUND });
    return;
  }
  res.json({ ok: true });
});

// POST /:toolId/test — run testConnection against stored creds
router.post(
  "/:toolId/test",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await resolveOwnedCompanyId(req);
    if (!companyId) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    const existing = await findOwnedToolById({
      id: req.params.toolId,
      companyId,
    });
    if (!existing) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TOOL_NOT_FOUND });
      return;
    }

    const entry = await findCatalogEntry(existing.type);
    if (!entry) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({ error: ERROR_CODES.TOOL_TYPE_UNKNOWN });
      return;
    }

    let creds: Record<string, unknown>;
    try {
      const { decryptCredentials } = await import("../../../lib/tool-crypto");
      creds = decryptCredentials<Record<string, unknown>>(
        existing.credentialsEncrypted as EncryptedBlob,
      );
    } catch (err) {
      log.error({ err, toolId: existing.id }, "tool test: decrypt failed");
      const body: TestCompanyToolResponse = {
        result: {
          ok: false,
          errorCode: "decrypt_failed",
          errorMessage:
            err instanceof Error ? err.message : "decrypt failed",
        },
      };
      res.json(body);
      return;
    }

    const result = await runTestConnection({
      entry,
      credentials: creds,
      metadata: (existing.metadata as Record<string, unknown>) ?? {},
    });

    const body: TestCompanyToolResponse = { result };
    res.json(body);
  },
);

// GET /:toolId/credentials — owner views the stored credentials for their
// own tool (endpoint URL, secret, etc.). Returns decrypted values keyed by
// field name; the client merges them with the catalog's credentialFields to
// label each and mask the secret-flagged ones. Scoped to the owner via
// resolveOwnedCompanyId — agents authenticate on a different router and never
// reach this route.
router.get(
  "/:toolId/credentials",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await resolveOwnedCompanyId(req);
    if (!companyId) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }
    const existing = await findOwnedToolById({
      id: req.params.toolId,
      companyId,
    });
    if (!existing) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TOOL_NOT_FOUND });
      return;
    }
    let creds: Record<string, unknown>;
    try {
      const { decryptCredentials } = await import("../../../lib/tool-crypto");
      creds = decryptCredentials<Record<string, unknown>>(
        existing.credentialsEncrypted as EncryptedBlob,
      );
    } catch (err) {
      log.error({ err, toolId: existing.id }, "tool credentials: decrypt failed");
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: ERROR_CODES.INTERNAL_ERROR });
      return;
    }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds)) {
      if (typeof v === "string") values[k] = v;
    }
    res.json({ values });
  },
);

// GET /:toolId/logs
router.get(
  "/:toolId/logs",
  requireAuth,
  async (req: Request, res: Response) => {
    const companyId = await resolveOwnedCompanyId(req);
    if (!companyId) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.COMPANY_NOT_FOUND });
      return;
    }

    const existing = await findOwnedToolById({
      id: req.params.toolId,
      companyId,
    });
    if (!existing) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.TOOL_NOT_FOUND });
      return;
    }

    const query = listToolLogsQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json({
          error: ERROR_CODES.INVALID_QUERY,
          detail: query.error.flatten(),
        });
      return;
    }

    const rows = await listForTool({
      toolId: existing.id,
      companyId,
      limit: query.data.limit,
      before: query.data.before ? new Date(query.data.before) : undefined,
    });
    const body: ListToolCallLogsResponse = {
      logs: rows.map(toToolCallLogDTO),
    };
    res.json(body);
  },
);

export default router;
