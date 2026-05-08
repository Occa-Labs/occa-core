// HTTP request bodies for /api/workflows. The YAML body itself is
// validated downstream by `parseWorkflowYaml` from @occa/shared/workflows
// — this schema only checks the envelope.

import { z } from "zod";

export const createWorkflowBody = z.object({
  yamlText: z.string().trim().min(1).max(20_000),
  enabled: z.boolean().optional(),
});

export const updateWorkflowBody = z.object({
  yamlText: z.string().trim().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
});

export type CreateWorkflowBody = z.infer<typeof createWorkflowBody>;
export type UpdateWorkflowBody = z.infer<typeof updateWorkflowBody>;
