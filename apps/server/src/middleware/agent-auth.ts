import type { Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import { verifyDeploymentKey } from "../features/agents/services/deployment-api-keys";

// `agentId` here holds the deployment UUID — same identifier the wire
// surfaces as `agentId` everywhere else, kept stable pending the
// shared/types migration to `deploymentId`.
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
  const verified = await verifyDeploymentKey(token);
  if (!verified) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: ERROR_CODES.INVALID_AGENT_TOKEN });
    return;
  }
  req.agent = {
    agentId: verified.deploymentId,
    companyId: verified.companyId,
    keyId: verified.keyId,
  };
  next();
}
