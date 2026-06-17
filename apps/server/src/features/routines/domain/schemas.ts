// Zod request schemas for the routines feature. Pure — no I/O.

import { z } from "zod";
import { ROUTINE_STATUSES, ROUTINE_TRIGGER_KINDS } from "@occa/shared/types";
import { LIMITS } from "../../../lib/limits";

export const triggerInputBase = z.object({
  kind: z.enum(ROUTINE_TRIGGER_KINDS),
  label: z.string().max(LIMITS.LABEL).optional(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().max(LIMITS.LABEL).optional(),
  timezone: z.string().max(LIMITS.TIMEZONE).optional(),
});
export type TriggerInput = z.infer<typeof triggerInputBase>;

export const createRoutineBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.KEY),
  description: z.string().max(LIMITS.DESCRIPTION_LONG).optional(),
  assigneeAgentId: z.string().uuid(),
  priority: z.string().max(LIMITS.TINY).optional(),
  // When set, a fire starts this sequential workflow (by yaml id) instead
  // of waking the assignee for free-form work. Empty string clears it.
  workflowYamlId: z.string().trim().max(LIMITS.KEY).optional(),
  triggers: z.array(triggerInputBase).min(1).max(LIMITS.TRIGGERS_MAX),
});

export const updateRoutineBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.KEY).optional(),
  description: z.string().max(LIMITS.DESCRIPTION_LONG).optional(),
  assigneeAgentId: z.string().uuid().optional(),
  priority: z.string().max(LIMITS.TINY).optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
  workflowYamlId: z.string().trim().max(LIMITS.KEY).optional(),
});

export const updateTriggerBody = z.object({
  label: z.string().max(LIMITS.LABEL).optional(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().max(LIMITS.LABEL).optional(),
  timezone: z.string().max(LIMITS.TIMEZONE).optional(),
});
