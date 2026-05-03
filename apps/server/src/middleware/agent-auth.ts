import type { Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { verifyAgentKey } from "../features/agents/services/agent-api-keys";

export interface AgentAuthContext {
  agentId: string;
  companyId: string;
  keyId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AgentAuthContext;
    }
  }
}

export async function requireAgentToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : null;
  if (!token) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.MISSING_TOKEN });
    return;
  }
  const verified = await verifyAgentKey(token);
  if (!verified) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.INVALID_AGENT_TOKEN });
    return;
  }
  req.agent = verified;
  next();
}
