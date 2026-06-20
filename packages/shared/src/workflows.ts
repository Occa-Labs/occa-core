// Workflow definition contract — shared between server CRUD and the
// workflow engine (server-only). The YAML authored by users is the
// canonical editable form; this module's Zod schemas validate it and
// produce a typed `WorkflowDefinition` that downstream code can rely
// on without re-parsing.
//
// Linear-only: `steps:` fan-out fixed children after task completion.
// The engine reads `parsedDefinition` (jsonb) at trigger time. Parse
// happens once on write; storage layer keeps yamlText + parsedDefinition
// in lockstep so reads never need YAML.parse.

import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";
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
// name (resolved at engine time), a `role:<persona>` tag, or the literal
// "human" to leave the task unassigned for a teammate to pick up.
//
// `kind`:
//   • spawn — ordinary work step; engine plain-advances on completion.
//   • gate  — a review/decision step. Still spawns a task (the reviewer does
//             the work), but on completion the engine reads the agent's
//             GATE_VERDICT marker (go/fail/kill) instead of blindly advancing.
//             FAIL bounces the cursor back to the prior draft step (capped by
//             caps.max_revisions); kill ends the run.
//   • tool  — a deterministic action step. The engine does NOT spawn a task:
//             it resolves `assigned_to` to a deployment and invokes the
//             company's `tool` (by type) action `action` AS that role, handing
//             it the prior step's output. A URL in the result is recorded as
//             the run's result_uri. On-rails: no agent free-improv. Generic —
//             publishing is `tool: publish, action: post`; a future tweet step
//             is `tool: x, action: post`. A tool step that is the last step
//             ends the run; otherwise the pipeline continues.
//
// `tool` + `action` are required when (and only when) kind is "tool".
const stepIdSlug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, {
    message: "id must be slug-shaped (alnum, hyphen, underscore)",
  });

const spawnStepSchema = z
  .object({
    kind: z.enum(["spawn", "gate", "tool"]).default("spawn"),
    // Optional stable handle for this step — referenced by a gate's
    // `on_fail_goto`. Only steps that are a bounce target need one.
    id: stepIdSlug.optional(),
    title: z.string().trim().min(1).max(200),
    assigned_to: z.string().trim().min(1).max(64),
    // Only for `kind: gate` — the `id` of the step to rewind the cursor to on a
    // FAIL verdict (re-runs the pipeline from there). Omit to use the default
    // (two steps back, for the legacy draft→verify→gate adjacency).
    on_fail_goto: stepIdSlug.optional(),
    // What the engine does if this step's task errors out (parks in `error`
    // after its trace-level retries are exhausted), so a dead step never
    // freezes the run:
    //   • retry (default) — re-spawn the step up to a cap, then fail the run.
    //                       Salvages a flaky step without losing the run.
    //   • fail_run        — end the run immediately; the routine fires a fresh
    //                       cycle. Opt in for a step where a retry can't help.
    //   • skip            — advance past the step. Use only for a non-critical
    //                       step the pipeline tolerates missing (e.g. a
    //                       cover-image brief, where downstream degrades to no
    //                       image).
    on_error: z.enum(["fail_run", "retry", "skip"]).optional(),
    // The step's instruction to the agent — prepended to the task body so it
    // leads, before the prior step's output. This is where authors shape what a
    // step does and what its output must look like (e.g. "output only the final
    // article, no meta" on the step before a publish step). The engine injects
    // it verbatim and never reads it; mechanism-critical contracts (the gate
    // verdict marker) are injected separately by the engine.
    prompt: z.string().trim().max(4000).optional(),
    acceptance_criteria: z.string().trim().max(2000).optional(),
    // Only meaningful for `kind: tool` — the company tool type to invoke and
    // the action name on it (e.g. publish/post).
    tool: z.string().trim().min(1).max(64).optional(),
    action: z.string().trim().min(1).max(64).optional(),
    // Only for `kind: tool` — explicit input mapping for the tool action,
    // moving input-shaping out of the engine and into the (reviewable) YAML.
    // Each value is a literal string, or a template referencing a prior step's
    // output:
    //   {{<id>.output}}        — that step's full deliverable text
    //   {{<id>.output.<field>}} — a field of a prior TOOL step's JSON output
    //                             (e.g. {{cover_image.output.url}})
    // When omitted, the engine falls back to its default mapping (carry the
    // immediately-prior step's output as `content`, derive a title from it).
    input: z.record(z.string(), z.string()).optional(),
  })
  .refine((s) => s.kind !== "tool" || (!!s.tool && !!s.action), {
    message: "tool steps require `tool` and `action`",
    path: ["tool"],
  });

// Meta-action step — does not spawn a task. Today only `close_parent`
// is supported (auto-resolve the parent task with a canned comment).
const metaActionStepSchema = z.object({
  action: z.enum(["close_parent"]),
  comment: z.string().trim().min(1).max(500).optional(),
});

const stepSchema = z.union([spawnStepSchema, metaActionStepSchema]);

// Matches a step-output reference inside a tool step's `input` value:
//   {{draft.output}}            → { id: "draft", field: undefined }
//   {{cover_image.output.url}}  → { id: "cover_image", field: "url" }
// Exported so the engine resolves references with the exact same grammar
// the schema validates against.
const OUTPUT_REF = /\{\{\s*([a-z0-9_-]+)\.output(?:\.([a-z0-9_]+))?\s*\}\}/gi;

export function extractOutputRefs(
  value: string,
): Array<{ id: string; field?: string }> {
  const refs: Array<{ id: string; field?: string }> = [];
  for (const m of value.matchAll(OUTPUT_REF)) {
    refs.push({ id: m[1]!, field: m[2] });
  }
  return refs;
}

// Replace every `{{id.output(.field)?}}` in `value` with whatever `lookup`
// returns for that reference. The engine supplies a lookup over the run's
// stored step outputs; keeping the substitution here means the schema's
// validation grammar and the engine's resolution grammar can never drift.
export function resolveOutputRefs(
  value: string,
  lookup: (id: string, field?: string) => string,
): string {
  return value.replace(OUTPUT_REF, (_m, id: string, field?: string) =>
    lookup(id, field),
  );
}

const capsSchema = z
  .object({
    max_depth: z.number().int().min(1).max(5).optional(),
    max_children: z.number().int().min(1).max(10).optional(),
    // Max times a `gate` FAIL verdict may bounce the run back to the
    // draft step before the engine force-kills the run. Guards against
    // an infinite draft→verify→gate→fail loop. Engine defaults to 2
    // when omitted.
    max_revisions: z.number().int().min(0).max(5).optional(),
  })
  .optional();

// Execution mode:
//   • parallel   — steps fan out in a single batch on parent completion
//                  (the original behaviour, kept as default for back-compat).
//   • sequential — steps run one at a time under a shared parent; the
//                  engine advances on each step's completion via a
//                  workflow_runs cursor. Started explicitly by a routine
//                  fire, NOT by task_type matching. Required for the
//                  news pipeline.
const executionModeSchema = z
  .enum(["parallel", "sequential"])
  .default("parallel");

// Linear workflow — `steps:` is a flat list. In `parallel` mode they are
// all spawned (or capped) in a single fan-out per parent completion; in
// `sequential` mode they advance one at a time under a shared parent.
const linearWorkflowSchema = z.object({
  id: yamlId,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  execution: executionModeSchema,
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(10),
  caps: capsSchema,
});

export const workflowDefinitionSchema = linearWorkflowSchema
  .strict()
  .superRefine((def, ctx) => {
    // Step ids must be unique, and every `on_fail_goto` must point at one — so a
    // gate can't be authored to bounce to a step that doesn't exist.
    const seen = new Set<string>();
    const ids = new Set<string>();
    def.steps.forEach((s) => {
      if ("id" in s && s.id) ids.add(s.id);
    });
    def.steps.forEach((s, i) => {
      if (!("title" in s)) return; // meta steps have no id/on_fail_goto
      // Tool `input` may only reference the output of a STRICTLY EARLIER step
      // (`seen` holds prior steps' ids — current id is added after this check).
      if (s.input) {
        for (const [key, value] of Object.entries(s.input)) {
          for (const ref of extractOutputRefs(value)) {
            if (!seen.has(ref.id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["steps", i, "input", key],
                message: `input references "${ref.id}.output" but no earlier step has id "${ref.id}"`,
              });
            }
          }
        }
      }
      if (s.id) {
        if (seen.has(s.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", i, "id"],
            message: `duplicate step id "${s.id}"`,
          });
        }
        seen.add(s.id);
      }
      if (s.on_fail_goto && !ids.has(s.on_fail_goto)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "on_fail_goto"],
          message: `on_fail_goto "${s.on_fail_goto}" matches no step id`,
        });
      }
    });
  });

export type SpawnStep = z.infer<typeof spawnStepSchema>;
export type MetaActionStep = z.infer<typeof metaActionStepSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type LinearWorkflowDefinition = z.infer<typeof linearWorkflowSchema>;
export type WorkflowDefinition = LinearWorkflowDefinition;

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

// Convert a typed definition back to a YAML string. Used by the form
// editor to serialize before POSTing — server still validates as a
// belt-and-braces check. Output is human-readable: 2-space indent,
// double-quoted titles to preserve `{{...}}` and special characters.
export function serializeWorkflowToYaml(def: WorkflowDefinition): string {
  return stringifyYaml(def, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
}

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
