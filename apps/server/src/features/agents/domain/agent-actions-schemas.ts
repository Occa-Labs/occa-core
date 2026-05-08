// Zod schemas for the typed-action HTTP back-channel
// (POST /api/agents/me/actions/emit). Mirrors the design doc's
// "Typed Action protocol" — a versioned, discriminated request body so
// adding a new action is a single new branch, not a new endpoint.

import { z } from "zod";
import { EFFORT_LEVELS, TASK_TYPES } from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";

const idempotencyKey = z.string().min(1).max(LIMITS.IDEMPOTENCY_KEY_MAX);
const taskIdField = z.string().uuid();

const emitFollowUpPayload = z.object({
  title: z.string().trim().min(1).max(LIMITS.TITLE),
  taskType: z.enum(TASK_TYPES).default("other"),
  acceptanceCriteria: z
    .string()
    .max(LIMITS.DESCRIPTION_SHORT)
    .optional(),
  effortLevel: z.enum(EFFORT_LEVELS).optional(),
  priority: z
    .enum(["low", "medium", "high", "urgent"] as const)
    .optional(),
  reason: z.string().max(LIMITS.REASON).optional(),
});

const requestInfoPayload = z.object({
  questionMarkdown: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
  // Names of @mentioned humans/agents — passed through to the comment
  // service which resolves them against the company's deployments.
  // Resolution semantics live in task-comments.ts; the route does not
  // pre-resolve to keep validation cheap.
});

export const agentActionRequest = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("EmitFollowUp"),
    parentTaskId: taskIdField,
    idempotencyKey,
    payload: emitFollowUpPayload,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("RequestInfo"),
    taskId: taskIdField,
    idempotencyKey,
    payload: requestInfoPayload,
  }),
]);

export type AgentActionRequest = z.infer<typeof agentActionRequest>;
export type EmitFollowUpRequest = Extract<
  AgentActionRequest,
  { type: "EmitFollowUp" }
>;
export type RequestInfoRequest = Extract<
  AgentActionRequest,
  { type: "RequestInfo" }
>;
