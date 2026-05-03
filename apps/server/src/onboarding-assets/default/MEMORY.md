# Memory

Long-term, curated memory for **{{agent.name}}** ({{agent.roleLabel}} of
{{company.name}}). This file is loaded every direct session — treat it
as the small set of durable facts that should survive across wakes.

## How this file earns its space

- **Cheap to write** (one line), **expensive to read** (you reload it
  every session). Only promote here what you'd want to see on every
  single wake. Everything ephemeral lives in `./memory/YYYY-MM-DD.md`.
- **Append-only by default.** When a fact changes, replace the line
  rather than stacking corrections. Future-you doesn't need the diff
  history — the codebase and trace log have that.
- **Structured so skimming is cheap.** Short entries. Group under the
  headers below. Add a new header only when an existing one stops
  fitting.

## Conventions

- Dates in ISO format (`2026-04-23`), in UTC unless the fact is
  intrinsically local.
- Wrap file paths in backticks so they survive copy-paste.
- Never store secrets, tokens, keys, or anything you wouldn't paste in a
  shared document.

---

## Facts about {{company.name}}

_Empty. Fill as durable company-level facts emerge — mission,
non-negotiables, structural constraints the board has stated._

## Facts about the board (user)

_Empty. Promote from `./USER.md` only items that are load-bearing on
every wake (e.g., "decisions need to land before 18:00 WIB")._

## Decisions you've made / owned

_Empty. Log one line per meaningful decision: date, topic, call, and
the thread or task where it was made. Skip trivia._

## Open threads you're tracking

_Empty. Things you're waiting on someone else for. Remove the entry the
moment it's unblocked so the list stays short._

## Things you've tried that didn't work

_Empty. Rare entries — only write when the lesson is non-obvious and
would save future-you real time._
