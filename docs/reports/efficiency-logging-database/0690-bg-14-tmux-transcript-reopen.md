# Reopening a tmux tab replays its whole transcript

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Bound the reopen read**: stop reading and sending the whole transcript per reopen. Status: open.

### 1. Bound the reopen read

**Problem.** Each reopen of a tmux tab reads the whole transcript file, in a container through `docker exec`, parses every line and sends all of it to the renderer.

**Context.** 1202 task 8 recommends paging but has not decided it.

**Investigation.** `transcriptLines` reads the file with `backend.readFile` and parses it all (`apps/backend/src/core/tmux-session-manager.ts:284-311`), behind `claude_tmux_transcript` (`apps/backend/src/core/tmux-commands.ts:346-351`). The tab calls it on reconcile (`apps/web/src/components/claude/ClaudeTmuxChatTab.tsx:403-406`, `apps/web/src/lib/claude-tmux-client.ts:263`). Each line carries the task list as it stood then, rebuilt from the start of the file (`tmux-session-manager.ts:290-300`), so any bounded read still has to answer for that state.

**Decisions.**

- **How to stop the replay?** (1202 recommends the first; not yet decided.)
  - **Page from the tail, as native transcripts page their history (recommended).**
    - Pros: one bounded read per reopen; the renderer already has a paged history view for native tabs.
    - Cons: the tmux chat tab has to move onto paged history, renderer and backend change together, and the historical task snapshots need a separate answer.
  - **Resume from the client's last byte offset.**
    - Pros: small backend change.
    - Cons: the offset is lost with the tab's state, and the task list must still be rebuilt from the start of the file.

## Constraints and rationale

A transcript row is one model response, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep). The new read needs byte and count bounds. Comments at `ClaudeTmuxChatTab.tsx:386-387` explain why a hidden tab must reconcile on return, and that must stay.

## Needs verification

- Real transcript sizes and reopen rates; the report's confidence is Medium, and nothing was measured.

## Related

- [Efficiency report, F](../2026-10-27-efficiency.md#f-background-loops-and-external-processes)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 8
