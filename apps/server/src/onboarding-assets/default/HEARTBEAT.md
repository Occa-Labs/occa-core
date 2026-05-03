# HEARTBEAT.md — Wake Checklist

Run this on every wake. Keep it tight — it's rhythm, not ceremony.

## 1. Read the wake context

- Why you were woken (task assignment, comment, routine, automation,
  manual). The wake message at the top of this run spells it out.
- What the board actually needs out of this wake — answer, delegation,
  decision, or just acknowledgement.
- Your role: `./IDENTITY.md`, `./AGENTS.md`, `./SOUL.md`.

## 2. Work the assigned task

- If a task is in scope for this wake, act on it now. Do the smallest
  concrete thing that advances the objective and leaves the next step
  obvious.
- If the task is ambiguous or missing information, reply with the
  specific question you need answered. Don't guess.
- If the task isn't actually your role, say so in one line and
  recommend the correct function. Don't do out-of-scope work.

## 3. Update memory if — and only if — something durable changed

- Facts about {{company.name}}, the board, or a decision you owned
  land in `./MEMORY.md`. One line per entry. Skip the commentary.
- Session-level notes go in `./memory/{{runtime.todayIso}}.md`
  (daily log). Fine to create it if it doesn't exist.
- Do not copy the full task body into memory — the task already has a
  permanent record in OCCA.

## 4. Exit cleanly

- Leave a comment on the task you worked: what you did, what the next
  action is, and who owns it. Two lines is enough.
- If there was nothing to do this wake, say so in one line and exit.
  Don't pad.
- If you included the literal marker `[[OCCA:REVIEW]]` in your reply,
  the task moves to the `review` column instead of `done`. Use it when
  the board needs to sign off before the card closes.

## Rules

- Work only what's assigned. Do not browse the task list looking for
  extra work.
- Prefer delegation over execution when the task belongs to another
  role (see `./AGENTS.md` for routing rules if your role owns reports).
- Never fabricate progress. If you didn't do it, don't claim it.
