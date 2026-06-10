# Context Engineering for OCCA Agents

How OCCA assembles the token context for every agent run, and the discipline
that keeps it correct. This is platform infrastructure: the Context Pipeline
(`services/memory/`) feeds every surface (chat, task, future heartbeat) for
every tenant and every adapter. Crypoch is used here only as a measurement
example — it is a tenant that runs on OCCA, not the thing being optimized.

Grounded in Anthropic's published guidance:

- Building Effective Agents — workflow vs agent, simplicity first
- How we built our multi-agent research system — orchestrator-worker, token economics
- Effective context engineering for AI agents — context as a finite resource, just-in-time loading

## The core principle

> Find the smallest set of high-signal tokens that maximize the likelihood of
> the desired outcome.

Context is a finite, depleting resource, not a storage bin. Two consequences
OCCA must design around:

1. **Context rot.** As token volume grows, the model's ability to recall any
   specific item inside that context degrades (transformers form n² pairwise
   relationships for n tokens; attention budget thins out). A bloated prompt is
   not just slow and expensive — it makes the agent *worse* at the actual task,
   because the real brief is drowned by low-signal filler.

2. **Token economics.** A multi-agent system spends ~15× the tokens of a single
   chat turn; a single agent ~4×. In Anthropic's eval, token usage alone
   explained ~80% of quality variance — but that means *relevant* context, not
   *more* context. Every inlined byte and every added hierarchy layer has a real
   recurring cost, so each must earn its place.

## What OCCA does today

The Context Pipeline is the right architecture: one `loadContext(deploymentId,
surface)` returns a canonical `ContextSpec`; per-surface renderers emit the
prompt. The problem is the **loading cadence**: every block is inlined full,
every run, with no budget.

Measured on a real task run (`renderTaskPrompt` for a news_writer, task #958):

| Block | Bytes | Share |
| --- | --- | --- |
| Skills markdown (8 skills, full) | 220,547 | 89% |
| └ one third-party research skill | 130,813 | 53% |
| Workspace files (SOUL/AGENTS/…) | 11,499 | 5% |
| Marker boilerplate + instructions | ~16,000 | 6% |
| **Actual task brief** | **~1,300** | **0.5%** |
| **Total prompt** | **248,086** | 100% |

The deliverable the agent must produce is 0.5% of what it reads. The run timed
out at the 10-minute task ceiling. This is the exact failure the original
pipeline design flagged and deferred: "full inline embed … NOT on-demand …
deferred to Phase 2 because OCCA adapter contract doesn't expose memory tool API
yet." Phase 2 is now due.

This is a platform defect. Any tenant that assigns a large skill, accumulates a
big Company Brain, or seeds verbose workspace files hits the same wall. It is
not a Crypoch problem.

### Where OCCA already aligns

- **Orchestrator-worker exists** — CEO → Head → leaf, each with its own session.
- **Subagents return condensed results** — `CHILD_RESULT_PREVIEW_MAX` caps child
  output surfaced to a parent (currently 4,000 chars; Anthropic's guide points
  to 1,000–2,000 tokens).
- **Agent on rails** — the CLAUDE.md invariant ("push work down to deterministic
  code, agent only for the irreducible remainder") is exactly Anthropic's
  "simplest solution first; only add agent complexity when it demonstrably pays."

### Where it violates the principle

1. **Pre-load everything, no budget.** Anthropic's directive is just-in-time:
   keep lightweight identifiers, load the body on demand. OCCA inlines all skill
   markdown into every wake. The justification on file ("agents skipped the
   fetch and refused tasks", 2026-05-20) is real but was solved with the
   heaviest possible hammer.

2. **No minimal-viable-set discipline on skills.** A leaf agent carries 8 skills
   including a 130KB one whose API keys aren't even provisioned. Anthropic:
   bloated tool/skill sets make context impossible to prune.

3. **Over-specified boilerplate.** ~16KB of marker contract is re-sent every
   turn at full verbosity — "hardcoding brittle logic in the prompt" rather than
   right-altitude guidance.

## Target design

Add a **context budget** discipline to the existing pipeline. The pipeline keeps
its shape (`loadContext` + renderers); we change *how much* of each tier reaches
the prompt and add a just-in-time path for the overflow.

### 1. Per-block inline budget (the immediate fix)

Each inlinable block gets a byte cap. Under the cap → inline full (preserves the
"unavoidable" property for small, high-signal skills). Over the cap → inline a
header slice (frontmatter + description + first section) plus a hard pointer to
fetch the full body via the existing on-demand endpoint
(`GET /api/me/agent/skills/:key`). Anthropic calls this progressive disclosure:
the agent pulls the rest only if the task needs it.

Apply to: skills (`renderSkillsBlock`), Company Brain (`formatCompanyBrain`),
workspace files (`formatWorkspaceFiles`).

Suggested starting caps (tunable, defined as named constants, not literals):

- per-skill inline cap: ~12 KB
- total skills budget: ~48 KB (drop or pointer lowest-priority skills past it)
- Company Brain budget: ~16 KB
- workspace files: keep (already ~11 KB; cap individual files at ~4 KB)

On the task above, a 12 KB per-skill cap alone takes the prompt from 248 KB to
roughly 90 KB; the total-skills budget pushes it under 60 KB.

### 2. Minimal-viable-set for skill assignment

Budget is a backstop; the real lever is not assigning skills an agent can't use.
A skill whose required env/API keys are unprovisioned should not be inlined at
all — surface it as a pointer or omit it. `loadSkills` already has the data to
filter on provisioning state.

### 3. Right-altitude boilerplate

The marker contract is static across all task runs. Compress it to a short,
high-signal form and move the exhaustive spec to a fetchable reference (the OCCA
Runtime skill already exists for this). Target: marker block well under 4 KB.

### 4. Tighten subagent result size

Lower `CHILD_RESULT_PREVIEW_MAX` from 4,000 chars toward the 1,500–2,000 range,
matching Anthropic's "condensed, distilled summary (1,000–2,000 tokens)" so a
synthesizing parent isn't re-reading full child transcripts.

### 5. Scale effort to complexity (later)

Anthropic gates agent count by query complexity (simple → 1 agent / 3–10 calls;
complex → 10+). OCCA has no equivalent — every task can fan out the full
hierarchy. A complexity hint on the task (or a cap derived from effort_level)
keeps token spend proportional. This is a follow-on, not part of the first cut.

## Rollout

Each phase is independently shippable and measurable against the dump script
(`apps/server/src/dump-task-prompt.ts`, to be removed after).

1. **Per-block budget + pointer** in `render/task.ts` and the mirrored
   `render/chat.ts`. Biggest single win. Verify a clean Crypoch task run lands
   under budget, completes without timeout, and still produces a correct
   deliverable (skills reachable on demand).
2. **Skill provisioning filter** in `loadSkills` — drop/Pointer unusable skills.
3. **Boilerplate compression** — marker contract to short form + reference skill.
4. **Subagent preview cap** — lower the constant.
5. **Complexity-scaled fan-out** — gate hierarchy depth by task effort.

## Acceptance

- A typical task prompt is **under ~60 KB**, dominated by the task brief and
  high-signal context, not by inlined reference material.
- Agents still complete tasks without "no skill available" refusals — the
  on-demand fetch path works and is exercised.
- Token usage per task run drops measurably (the live priority), tracked via the
  per-trace `usage_json` once persistence is confirmed.
- The discipline holds for any tenant, not just the one we measured.

## References

- `services/memory/load-context.ts` — the single loader
- `services/memory/render/task.ts`, `render/chat.ts` — surface renderers
- `services/memory/stores/skills.ts` — skill roster loader
- `features/skills/routes/agent-me.ts` — on-demand skill fetch endpoint
- [project_context_engineering_design](memory) — the original 4-tier pipeline design
