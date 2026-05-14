# Delegation

Single-folder home for the hierarchical delegation algorithm
(User ↔ CEO ↔ Head ↔ Specialist). Centralised because the same rules
are referenced in three places that would otherwise drift apart:
the prompt the LLM sees, the markers it emits, and the server-side
checks that validate them.

## Layout

```
delegation/
├── policy.ts             — algorithm + LLM-facing prompt fragments
├── synthesis.ts          — chat-mode callback when a delegated task finishes
└── markers/
    ├── schemas.ts        — zod for DELEGATE / BLOCK payloads
    ├── handlers.ts       — per-token side effects (auto-create child task, etc.)
    └── parser.ts         — extracts + routes markers from agent reply
```

## What each file owns

**`policy.ts`** — `tierRank`, `sortByDelegationPriority`,
`shouldBypassReport`, `renderReportsBlock`, `renderRootReportBlock`.
Server-side bypass guard and LLM-facing prompt fragments are twins:
edit one without the other and the system drifts.

**`synthesis.ts`** — `synthesizeCeoReplyForTask`. Triggered by cascade
when a task born from chat (`originating_user_id` set) finishes. Wakes
the CEO via the SAME chat session, hands it the subordinate's result,
posts the synthesized reply back to the chat thread.

**`markers/schemas.ts`** — zod for DELEGATE + BLOCK JSON payloads.
REPORT is intentionally schemaless (body is plain markdown).

**`markers/handlers.ts`** — `handleDelegateBlock` (auto-creates child
task), `handleBlockBlock` (writes blocker dependencies), `handleReportBlock`
(validates + defers chat-commit to dispatcher).

**`markers/parser.ts`** — `processActionBlocks`. Lifts `[[OCCA:*]]`
blocks out of an agent reply and routes each to the right handler.

## Who calls in

- `features/tasks/services/dispatcher.ts` — wires `processActionBlocks`
  + `shouldBypassReport` into the task lifecycle.
- `features/tasks/services/cascade.ts` — calls `synthesizeCeoReplyForTask`
  when a chat-origin task completes.
- `features/chat/services/chat-handler.ts` — parses DELEGATE+CREATE_TASK
  out of CEO chat replies (uses `@occa/shared/markers` extractor + own
  body readers; does NOT call into `markers/handlers.ts`).
- `services/context/load-context.ts` — `sortByDelegationPriority`.
- `services/context/render-task.ts` — `renderReportsBlock` +
  `renderRootReportBlock`.

## Invariants (do not break)

1. Only CEO tier emits REPORT. `handleReportBlock` rejects non-CEO with
   `non_ceo_cannot_report`. Specialists / Heads bubble up via cascade.
2. REPORT body is plain markdown, never JSON. Empirically LLMs fail
   JSON escape on long bodies.
3. Bypass guard fires only on root tasks with subordinates available
   when DELEGATE was skipped AND no children have completed yet — see
   four-condition comment in `policy.ts:shouldBypassReport`.
4. Specialists have no subordinates list (`getTier === "specialist"`
   short-circuits `listSubordinates`). Loop-incident 2026-05-13 came
   from a top-level specialist seeing the whole company.
5. Chat-mode DELEGATE creates exactly ONE task (subordinate's).
   Chat-mode CREATE_TASK creates exactly ONE task (CEO's). No wrapper.
   Synthesis lives outside the task graph.
