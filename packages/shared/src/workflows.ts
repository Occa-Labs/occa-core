// Workflow definition contract — shared between server CRUD (Phase 5)
// and the future workflow engine (Phase 6, server-only). The YAML
// authored by users is the canonical editable form; this module's Zod
// schemas validate it and produce a typed `WorkflowDefinition` that
// downstream code can rely on without re-parsing.
//
// Two shapes are supported per task-system-design.md §Workflow concrete
// sketch:
//   - linear   (`steps:`)  — fan-out fixed children after task completion
//   - branched (`classify:` + `branches:`) — LLM picks a branch by label
//
// The engine reads `parsedDefinition` (jsonb) at trigger time. Parse
// happens once on write; storage layer keeps yamlText + parsedDefinition
// in lockstep so reads never need YAML.parse.

import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

// Slug-shaped workflow id, unique per company. Constrained to keep the
// URL path / event payload stable — humans copy these into prompts.
const yamlId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, {
    message: "yaml_id must be slug-shaped (alnum + hyphens)",
  });

const triggerSchema = z.object({
  when: z.literal("task.completed"),
  match: z.object({
    task_type: z.string().trim().min(1).max(64),
  }),
});

// Spawn step — creates a child task. `assigned_to` may be a deployment
// name (resolved at engine time) or the literal "human" to leave the
// task unassigned for a teammate to pick up.
const spawnStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  assigned_to: z.string().trim().min(1).max(64),
  acceptance_criteria: z.string().trim().max(2000).optional(),
});

// Meta-action step — does not spawn a task. Today only `close_parent`
// is supported (auto-resolve the parent task with a canned comment).
const metaActionStepSchema = z.object({
  action: z.enum(["close_parent"]),
  comment: z.string().trim().min(1).max(500).optional(),
});

const stepSchema = z.union([spawnStepSchema, metaActionStepSchema]);

const capsSchema = z
  .object({
    max_depth: z.number().int().min(1).max(5).optional(),
    max_children: z.number().int().min(1).max(10).optional(),
  })
  .optional();

// Linear workflow — `steps:` is a flat list, all spawned (or skipped)
// in a single fan-out per parent completion.
const linearWorkflowSchema = z.object({
  id: yamlId,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(10),
  llm_can_deviate: z.boolean().optional(),
  caps: capsSchema,
});

// Branched workflow — LLM classifies the parent result into one of the
// branch labels, then we run that branch's step list. At least one
// branch required; branch keys are arbitrary slugs the classifier picks.
const branchedWorkflowSchema = z.object({
  id: yamlId,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  trigger: triggerSchema,
  classify: z.object({
    prompt: z.string().trim().min(1).max(2000),
  }),
  branches: z
    .record(
      z.string().trim().min(1).max(64),
      z.array(stepSchema).min(1).max(10),
    )
    .refine((b) => Object.keys(b).length >= 1, {
      message: "branches must have at least one entry",
    }),
  llm_can_deviate: z.boolean().optional(),
  caps: capsSchema,
});

export const workflowDefinitionSchema = z.union([
  linearWorkflowSchema.strict(),
  branchedWorkflowSchema.strict(),
]);

export type SpawnStep = z.infer<typeof spawnStepSchema>;
export type MetaActionStep = z.infer<typeof metaActionStepSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type LinearWorkflowDefinition = z.infer<typeof linearWorkflowSchema>;
export type BranchedWorkflowDefinition = z.infer<typeof branchedWorkflowSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function isLinearWorkflow(
  def: WorkflowDefinition,
): def is LinearWorkflowDefinition {
  return "steps" in def;
}

export function isBranchedWorkflow(
  def: WorkflowDefinition,
): def is BranchedWorkflowDefinition {
  return "branches" in def;
}

export interface ParsedWorkflow {
  yamlText: string;
  definition: WorkflowDefinition;
}

export type WorkflowParseFailure =
  | { kind: "yaml_syntax"; message: string; line?: number; col?: number }
  | { kind: "schema"; issues: z.ZodIssue[] };

export type WorkflowParseResult =
  | { ok: true; value: ParsedWorkflow }
  | { ok: false; error: WorkflowParseFailure };

// Two-stage parse: YAML → object, then Zod → typed definition. YAML
// errors return location info so the UI can highlight a line; Zod
// errors flatten through the API in the same shape used by other
// validation endpoints.
export function parseWorkflowYaml(yamlText: string): WorkflowParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      return {
        ok: false,
        error: {
          kind: "yaml_syntax",
          message: err.message,
          line: err.linePos?.[0]?.line,
          col: err.linePos?.[0]?.col,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "yaml_syntax",
        message: err instanceof Error ? err.message : "unknown YAML error",
      },
    };
  }
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "schema", issues: parsed.error.issues },
    };
  }
  return { ok: true, value: { yamlText, definition: parsed.data } };
}
