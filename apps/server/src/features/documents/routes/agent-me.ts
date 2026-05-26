// Agent-facing documents API mounted at /api/me/agent/documents.
//
// Mirrors the user-facing endpoint at /api/documents but authenticates
// via the per-trace API key and scopes reads to the calling agent's
// company. Documents are the company's shared episodic memory — every
// agent can fetch any company doc (no per-agent ACL today).
//
// Snippets are intentionally not truncated server-side; the agent
// asks for one doc at a time and gets the full content.

import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { requireAgentToken } from "../../../middleware/agent-auth";
import {
  findById as findDocumentById,
  listByAnyTag as listDocumentsByAnyTag,
  listRecent as listRecentDocuments,
  type DocumentRow,
} from "../repositories/documents";

const router: Router = Router();

interface AgentDocumentDTO {
  id: string;
  taskId: string | null;
  deploymentId: string | null;
  title: string;
  format: string;
  tags: string[];
  createdAt: string;
}

interface AgentDocumentFullDTO extends AgentDocumentDTO {
  content: string;
}

function toAgentDocumentListItem(row: DocumentRow): AgentDocumentDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    deploymentId: row.deploymentId,
    title: row.title,
    format: row.format,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAgentDocumentFull(row: DocumentRow): AgentDocumentFullDTO {
  return { ...toAgentDocumentListItem(row), content: row.content };
}

const AGENT_DOCS_DEFAULT_LIMIT = 25;
const AGENT_DOCS_MAX_LIMIT = 100;

// GET /api/me/agent/documents?tags=foo,bar&limit=25
// List documents in the agent's company, recency-ordered. ?tags filters
// to docs whose tags overlap any of the comma-separated values.
router.get("/", requireAgentToken, async (req: Request, res: Response) => {
  const { companyId } = req.agent!;

  const limitRaw = Number(req.query.limit ?? AGENT_DOCS_DEFAULT_LIMIT);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), AGENT_DOCS_MAX_LIMIT)
      : AGENT_DOCS_DEFAULT_LIMIT;

  const tagsParam =
    typeof req.query.tags === "string" ? req.query.tags : "";
  const tags = tagsParam
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const rows =
    tags.length > 0
      ? await listDocumentsByAnyTag({ companyId, tags, limit })
      : await listRecentDocuments({ companyId, limit });

  res.json({ documents: rows.map(toAgentDocumentListItem) });
});

// GET /api/me/agent/documents/:id
// Full document content. Returns 404 if the doc belongs to another
// company (or doesn't exist).
router.get(
  "/:id",
  requireAgentToken,
  async (req: Request, res: Response) => {
    const { companyId } = req.agent!;
    const row = await findDocumentById({ companyId, id: req.params.id });
    if (!row) {
      res.status(StatusCodes.NOT_FOUND).json({ error: ERROR_CODES.NOT_FOUND });
      return;
    }
    res.json({ document: toAgentDocumentFull(row) });
  },
);

export default router;
