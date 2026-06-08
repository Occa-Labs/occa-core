// Pure zod schemas for task CRUD bodies. No drizzle, no Express, no fetch.
// Routes import these and feed them to .safeParse(); services receive
// already-parsed values.

import { z } from "zod";
import {
  EFFORT_LEVELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type ContentBlock,
} from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";

// Discriminated content-block tree. Mirrors the shared `ContentBlock`
// union so refactors in @occa/shared/types surface as type errors here.
export const contentBlockSchema: z.ZodType<ContentBlock> =
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("paragraph"), text: z.string() }),
    z.object({ type: z.literal("heading_1"), text: z.string() }),
    z.object({ type: z.literal("heading_2"), text: z.string() }),
    z.object({ type: z.literal("heading_3"), text: z.string() }),
    z.object({ type: z.literal("bullet"), text: z.string() }),
    z.object({
      type: z.literal("checklist"),
      text: z.string(),
      checked: z.boolean(),
    }),
    z.object({ type: z.literal("quote"), text: z.string() }),
    z.object({ type: z.literal("code"), text: z.string() }),
    z.object({ type: z.literal("divider") }),
    z.object({
      type: z.literal("agent_result"),
      traceId: z.string().uuid(),
      agentId: z.string().uuid(),
      agentName: z.string(),
      timestamp: z.string().datetime(),
      preview: z.string(),
    }),
  ]);

export const createTaskBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.TITLE),
  blocks: z.array(contentBlockSchema).max(LIMITS.TASK_BLOCKS_MAX).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  effortLevel: z.enum(EFFORT_LEVELS).optional(),
  tags: z
    .array(z.string().trim().min(1).max(LIMITS.TAG))
    .max(LIMITS.TAGS_MAX)
    .optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
  // Published URL of the deliverable — anchored on-chain as the trace's
  // result_uri. Empty string is accepted and normalized to null (private).
  resultUri: z
    .string()
    .trim()
    .max(LIMITS.URL)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), {
      message: "must be an http(s) URL",
    })
    .nullable()
    .optional(),
});

export const updateTaskBody = createTaskBody.partial();

export const commentBody = z.object({
  body: z.string().trim().min(1).max(LIMITS.DESCRIPTION),
});

export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type CommentBody = z.infer<typeof commentBody>;
