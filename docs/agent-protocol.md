# Agent Protocol

Contract between an OCCA agent runtime (today: OpenClaw) and the OCCA server. Two channels — block markers and HTTP — plus a unified per-task event log that captures every action.

Companion docs: [task-system-design.md](../../task-system-design.md), [task-system-implementation-plan.md](../../task-system-implementation-plan.md).

## Overview

| Channel | When to use | Validation timing |
|---|---|---|
| **Block markers** in reply text | Status changes (REVIEW), structural side-effects detected at trace finalize (HIRE/DELEGATE/BLOCK/ASK) | Parsed when the trace's reply is persisted |
| **HTTP back-channel** | Mid-task signals + idempotent side-effects (EmitFollowUp, RequestInfo) | Validated at request time, returns success/failure synchronously |

Every action — regardless of channel — produces an `agent_action_emitted` row in `task_events` for audit and timeline rendering.

## Authentication

All HTTP back-channel calls authenticate as the agent itself.

```
Authorization: Bearer occa_ag_<token>
```

- Tokens are minted per trace by the worker dispatcher (`mintEphemeralAgentKey` in [apps/worker/src/dispatcher.ts](../apps/worker/src/dispatcher.ts)).
- Validated by `requireAgentToken` middleware ([apps/server/src/middleware/agent-auth.ts](../apps/server/src/middleware/agent-auth.ts)) — sha256 hash lookup against `deployment_api_keys`.
- The middleware sets `req.agent = { agentId, companyId, keyId }`. The server reads identity from this; the client never passes it.

## Block markers

Defined in [packages/shared/src/markers.ts](../packages/shared/src/markers.ts). Two formats:

### Single-tag (no body)

```
[[OCCA:REVIEW]]
```

Currently only `REVIEW` uses this — signals "task done, awaiting human approval."

### Block (JSON body)

```
[[OCCA:HIRE]]
{ "targetRole": "...", "targetName": "...", "title": "...", "description": "..." }
[[/OCCA:HIRE]]
```

| Token | Body shape | Server effect |
|---|---|---|
| `HIRE` | `{ targetRole, targetName, title, description, acceptanceCriteria? }` | Pending `approvals` row (`actionType=hire`); task status → `review` |
| `DELEGATE` | `{ targetAgentId, title, description, acceptanceCriteria? }` | Pending `approvals` row (`actionType=delegate`); task status → `review` |
| `BLOCK` | `{ blockedByTaskIds: string[], reason? }` | `tasks.blockedByTaskIds` populated; status → `blocked`. `task-cascade.ts` unblocks on dependent completion |
| `ASK` | `{ question: string, mentionAgentId? }` | `task_comments` row inserted with optional @mention wake; status → `review` |

### Marker consumption

Markers are parsed by [features/tasks/services/dispatcher.ts](../apps/server/src/features/tasks/services/dispatcher.ts) (server path) at trace finalize via [features/tasks/services/action-blocks/parser.ts](../apps/server/src/features/tasks/services/action-blocks/parser.ts). The worker trace-dispatch path does **not** parse markers today — known limitation. Mirror is on the roadmap.

## HTTP back-channel

### `POST /api/agents/me/actions/emit`

Single endpoint, discriminated by `type`. Versioned for forward compat.

```http
POST /api/agents/me/actions/emit
Authorization: Bearer occa_ag_<token>
Content-Type: application/json

{
  "version": 1,
  "type": "EmitFollowUp" | "RequestInfo",
  "idempotencyKey": "<string, max 128>",
  ...
}
```

#### `EmitFollowUp` — spawn a child task

```json
{
  "version": 1,
  "type": "EmitFollowUp",
  "parentTaskId": "<uuid of the task this is being spawned from>",
  "idempotencyKey": "<unique per agent>",
  "payload": {
    "title": "<task title>",
    "taskType": "feature" | "bug" | "research" | "docs" | "chore" | "other",
    "acceptanceCriteria": "<optional, max 2000 chars>",
    "effortLevel": "xs" | "s" | "m" | "l" | "xl",
    "priority": "low" | "medium" | "high" | "urgent",
    "reason": "<optional, why this child was spawned>"
  }
}
```

Response:
- `201 Created` first time: `{ "taskId": "<uuid>", "alreadyExisted": false }`
- `200 OK` retry with same idempotencyKey: `{ "taskId": "<same uuid>", "alreadyExisted": true }`
- `403 Forbidden`: `{ "error": "task_not_in_company" }` (parent task not in agent's company)
- `422 Unprocessable Entity`:
  - `{ "error": "task_depth_exceeded" }` — chain depth > 2 (data-driven cap)
  - `{ "error": "task_children_exceeded" }` — already spawned 3 children for this parent

The child task is created with `assignedDeploymentId = null` — server picks routing later. Caps come from [apps/server/src/lib/limits.ts](../apps/server/src/lib/limits.ts).

#### `RequestInfo` — post a question on the current task

```json
{
  "version": 1,
  "type": "RequestInfo",
  "taskId": "<uuid of the task being worked on>",
  "idempotencyKey": "<unique per agent>",
  "payload": {
    "questionMarkdown": "<markdown body, max 4000 chars>"
  }
}
```

The body may include `@<agent-name>` tokens — they are resolved against company deployments and woken via `task-comments.ts`.

Response:
- `201 Created` first time: `{ "commentId": "<uuid>", "alreadyExisted": false }`
- `200 OK` retry: `{ "commentId": "<same uuid>", "alreadyExisted": true }`
- `403 Forbidden`: `{ "error": "task_not_in_company" }`

### Idempotency

`agent_action_idempotency` table dedupes by `(deployment_id, action_type, idempotency_key)`. Replays return the original resource id without re-running the side-effect. Caller should use a stable key per logical action — e.g. a hash of `(currentTaskId, payload)` or a deterministic per-task UUID.

### Caps and stopping conditions

From the design doc's data-driven analysis:

| Cap | Default | Source |
|---|---|---|
| `TASK_CHAIN_MAX_DEPTH` | 2 | Long-horizon degradation past depth 2 (SlopCodeBench) |
| `TASK_EMIT_MAX_CHILDREN` | 3 | Prevents fan-out runaway (BabyAGI #56) |
| `IDEMPOTENCY_KEY_MAX` | 128 chars | Validation bound |

Hardcoded for foundation; per-company overrides ship in feature phase.

## Channel selection guide

| Action category | Channel | Reason |
|---|---|---|
| Status changes (REVIEW, BLOCK) | Block marker | Emitted at end of output, contextual to reply |
| Side-effects (EmitFollowUp, comment posts) | HTTP back-channel | Validated, idempotent, separate from output |
| Mid-task signals (RequestInfo) | HTTP back-channel | Real-time, no wait for output completion |
| Existing approvals (HIRE, DELEGATE) | Block marker | Backwards-compat with existing `approvals` flow |

## Event log contract — `task_events`

Every action emits a row to `task_events`. Schema in [packages/shared/src/schema.ts](../packages/shared/src/schema.ts) (search `taskEvents`). Append-only — no UPDATE, no DELETE in application code. Per-task `sequence` is monotonic.

Event types:

| `event_type` | Emitter | Payload shape |
|---|---|---|
| `task_created` | `features/tasks/routes/tasks.ts`, `features/agents/services/agent-actions.ts` (EmitFollowUp), `routes/approvals.ts` (DELEGATE accept) | `{ title, taskType, parentTaskId, via? }` |
| `task_assigned` | `features/tasks/routes/tasks.ts` | `{ deploymentId, previousDeploymentId? }` |
| `task_status_changed` | `features/tasks/services/{dispatcher,cascade}.ts`, `apps/worker/src/task-sync.ts`, `features/tasks/routes/tasks.ts` | `{ from, to, reason, ...ctx }` |
| `agent_trace_started` | `features/tasks/services/dispatcher.ts` (server path), `apps/worker/src/task-sync.ts` (worker path) | `{ traceId, deploymentId }` |
| `agent_trace_finished` | `features/tasks/services/dispatcher.ts`, `apps/worker/src/task-sync.ts` | `{ traceId, outcome }` |
| `agent_action_emitted` | `features/tasks/services/dispatcher.ts` (markers), `features/agents/services/agent-actions.ts` (HTTP) | `{ actionType, channel, ...actionSpecific }` |
| `comment_added` | `features/tasks/services/comments.ts` | `{ commentId, body, mentions }` |
| `task_blocked` | `features/tasks/services/dispatcher.ts` (BLOCK marker) | `{ blockedByTaskIds }` |
| `task_unblocked` | `features/tasks/services/cascade.ts` | `{ by, lastBlockerTaskId }` |

Best-effort writes via `appendTaskEventBestEffort` — if the append fails, the parent operation completes; only the audit row is lost. Phase 1 is observability-only, so loss is acceptable.

## Known limitations

- **Worker dispatch path does not parse markers.** Only the server task-dispatcher path ([apps/server/src/features/tasks/services/dispatcher.ts](../apps/server/src/features/tasks/services/dispatcher.ts)) extracts and processes block markers. Tasks executed via the worker `dispatcher.ts` (`executeTrace` adapter contract) emit `agent_trace_*` events but no `agent_action_emitted` for in-text markers. Address when the worker path needs marker semantics.
- **Per-trace key is minted only on the worker path.** The server `sendPrompt` dispatch path doesn't mint a per-trace key; agents on that path can still call HTTP endpoints if they have a longer-lived deployment key, but ephemeral-key semantics differ between paths.
- **No webhook/external-trigger surface.** All actions originate from a running agent context with a valid bearer token. External triggers (Lindy-style) are deferred to feature phase.
