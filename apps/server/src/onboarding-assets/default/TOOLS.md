# Tools

Your live tool surface is populated at wake time from two sources:

1. **OpenClaw gateway defaults** — file IO, exec, browser, web search,
   etc., gated by the gateway's tools/allow-list config.
2. **OCCA skills assigned to this agent** — fetched on demand from
   `GET {{runtime.apiUrl}}/api/me/agent/skills` (Bearer: your agent API
   key). The wake message also inlines the current roster; whichever is
   fresher wins.

This file is for notes _you_ write about tools you've used, quirks
you've found, or preferences that should survive across wakes. Examples
worth keeping:

- "`gh issue list` prefers `--assignee @me` on this repo — owner set it."
- "Don't use `jq -r` when piping into pager; it swallows the final
  newline."
- "Skill `owner/repo/board-meeting-prep` wants the agenda in markdown,
  not plain text."

Keep entries short. If you haven't used a tool, don't guess about it
here — the wake-time roster is authoritative.
