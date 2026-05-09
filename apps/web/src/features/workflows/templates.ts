// Hardcoded template catalog for the workflow creation flow. Picked at
// "New workflow" → template gallery; the chosen YAML is loaded into the
// editor and the user can edit before saving. Kept client-side so the
// gallery renders without a network round-trip; templates rarely change
// and there's no per-company customization yet.
//
// Trigger task_type values are constrained to the 6 TaskType enum
// values (feature / bug / research / docs / chore / other) so a freshly
// saved template fires immediately against tasks the user can actually
// create from the UI.

export interface WorkflowTemplate {
  id: string;
  label: string;
  summary: string;
  yamlText: string;
}

const RESEARCH_PIPELINE: WorkflowTemplate = {
  id: "research-pipeline",
  label: "Research Pipeline",
  summary:
    "When a research task completes, fan out to summary, sources, fact-check, and outline draft.",
  yamlText: `id: research-pipeline
name: Research Pipeline
description: Auto-spawn summary, sources, fact-check, and outline draft after a research task completes.

trigger:
  when: task.completed
  match:
    task_type: research

steps:
  - title: "Summarise findings for {{parent.title}}"
    assigned_to: human
    acceptance_criteria: 300-500 word summary of thesis, evidence, and open questions.

  - title: "Compile source list for {{parent.title}}"
    assigned_to: human
    acceptance_criteria: Markdown bullet list of every source with author, publication, access date.

  - title: "Fact-check {{parent.title}}"
    assigned_to: human
    acceptance_criteria: Verify load-bearing claims against sources. Flag any claim that lacks one.

  - title: "Draft outline for {{parent.title}}"
    assigned_to: human
    acceptance_criteria: H1 / H2 / H3 outline ready for a writer to fill in.
`,
};

const BLOG_POST_PIPELINE: WorkflowTemplate = {
  id: "blog-post-pipeline",
  label: "Blog Post Pipeline",
  summary:
    "After a docs task completes, fan out to fact-check, SEO review, and image suggestions.",
  yamlText: `id: blog-post-pipeline
name: Blog Post Pipeline
description: Auto-spawn fact-check, SEO review, and image suggestions after a docs/blog draft completes.

trigger:
  when: task.completed
  match:
    task_type: docs

steps:
  - title: "Fact-check {{parent.title}}"
    assigned_to: human
    acceptance_criteria: Verify all numeric claims and named sources against primary references.

  - title: "SEO review {{parent.title}}"
    assigned_to: human
    acceptance_criteria: Check title length, meta description, heading hierarchy, internal-link density.

  - title: "Suggest images for {{parent.title}}"
    assigned_to: human
    acceptance_criteria: Recommend 3-5 hero / inline images.
`,
};

const BLANK_LINEAR: WorkflowTemplate = {
  id: "blank-linear",
  label: "Blank workflow",
  summary: "Start from an empty workflow with one placeholder step.",
  yamlText: `id: my-workflow
name: My Workflow
description: One-line summary of when this fires.

trigger:
  when: task.completed
  match:
    task_type: other

steps:
  - title: "Follow-up step for {{parent.title}}"
    assigned_to: human
`,
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  RESEARCH_PIPELINE,
  BLOG_POST_PIPELINE,
  BLANK_LINEAR,
];
