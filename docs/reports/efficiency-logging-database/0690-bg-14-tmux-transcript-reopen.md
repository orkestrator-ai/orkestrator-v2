# Reopening a tmux tab replays its whole transcript

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Bound the reopen read**: stop reading and sending the whole transcript per reopen. Status: done, with its live evidence moved to to-do 5120; see [Outcome](#outcome).

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

## Outcome

Checked back item by item on 2026-11-05. The base commit is `48d2ed40c`, where this file reads as it did before this outcome was added: `git show 48d2ed40c:docs/reports/efficiency-logging-database/0690-bg-14-tmux-transcript-reopen.md`. The finding still held when re-checked at `e198fd4a7`, with `transcriptLines` at `tmux-session-manager.ts:285-310`, so nothing below is recorded as no longer holding.

The report has one numbered task. The table splits it into what that task and the report's other sections ask for, so each part has its own outcome. To-do 5120 also carries one item the report did not name, as its task 3: the poll tail's one whole-file pass per session.

Read sizes come from `apps/backend/scripts/tmux-reopen-read-size.ts`, workload "longest session (37 MB)", through a fake `docker`. Before: 36,853,890 bytes, 2 execs, 9,000 lines. After: 524,306 bytes, 1 exec, 128 lines.

| Report item | Outcome | Code | Tests or evidence |
| --- | --- | --- | --- |
| Task 1: stop reading and sending the whole transcript per reopen | Done | `TmuxTranscriptReader.readPage` (`tmux-transcript-reader.ts`), `TmuxBackend.readTranscriptWindow` (`tmux-backend.ts`), optional `page` on `claude_tmux_transcript` (`tmux-commands.ts`) | `tmux-transcript-reader.test.ts`: "reopening a long transcript reads one bounded page, however long it grows". `tmux-reopen-read-size.test.ts`: "a reopen reads one bounded window, where it used to read the whole file". `tmux-commands.test.ts`: "serves a bounded page to a caller that asks for one, and the whole file to one that does not" |
| Task 1 decision: page from the tail or resume from a byte offset | Done: page from the tail, the recommended option | As above | As above |
| Task 1 con: the tmux chat tab has to move onto paged history | Done | `getTranscriptPage` (`claude-tmux-client.ts`), `applyTailPage` and `prependTranscriptPage` (`claudeTmuxStore.ts`), `ClaudeTmuxChatTab.tsx` | `ClaudeTmuxChatTab.test.tsx`: "opens on the tail with one read, and pages earlier history in on request", "earlier history remains loadable after a stopped event". `claudeTmuxStore.test.ts`: "an earlier page lands above the loaded rows and moves the cursor on". `tmux-transcript-reader.test.ts`: "walking back through the pages reproduces the file exactly once, multi-byte text included" |
| Task 1 con: historical task snapshots need a separate answer | Done | `TaskSnapshotHistory` and `TranscriptTaskTracker` (`claude-transcript-tasks.ts`), fed by the reader | `tmux-transcript-reader.test.ts`: "pages carry the same stamps as the whole-file read, from any page", "the current task list stays correct when no page reaches the task calls" |
| Task 1 problem: the read goes through `docker exec` in a container | Moved to to-do [5120](../../todo/transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md), task 2 | `transcriptWindowCommand` (`tmux-shared.ts`) | Proven under a real `/bin/sh` and through a fake `docker` only. No real container was run |
| Constraint: the new read needs byte and count bounds | Done | `TMUX_TRANSCRIPT_PAGE_BYTES`, `TMUX_TRANSCRIPT_PAGE_LINES` (`tmux-transcript-reader.ts`), `TASK_SNAPSHOT_HISTORY_MAX_ENTRIES`, `TASK_SNAPSHOT_HISTORY_MAX_BYTES` (`claude-transcript-tasks.ts`) | `tmux-transcript-reader.test.ts`: "stops at the record bound, naming where the next page ends", "stops at the byte bound, but always returns the newest record", "forgets the oldest calls past its count bound", "forgets the oldest calls past its byte bound" |
| Constraint: a transcript row is one model response | Done | `cutTranscriptWindow` (`tmux-transcript-reader.ts`) serves the file's own whole records and merges none | `tmux-transcript-reader.test.ts`: "walking back through the pages reproduces the file exactly once, multi-byte text included" |
| Constraint: a hidden tab must reconcile on return | Done | The mount effect in `ClaudeTmuxChatTab.tsx` still reconciles, now by reading the tail page | `ClaudeTmuxChatTab.test.tsx`: "hydrates a running backend session and replays missed transcript before auto-starting", "a reopen on a mounted store keeps the rows the reader paged in". `claudeTmuxStore.test.ts`: "starts again from the tail when more than a page was missed" |
| Needs verification: real transcript sizes | Moved to to-do [5120](../../todo/transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md), task 1 | None | Sizes were measured on one host by file size only, and that population mixes native and tmux sessions |
| Needs verification: reopen rates | Moved to to-do [5120](../../todo/transcripts-and-observation/5120-tmux-transcript-reopen-live-evidence.md), task 1 | None | Not measured: no counter records a tab reopen |
