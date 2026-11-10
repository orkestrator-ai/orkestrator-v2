# Tmux transcript reopen: live evidence and the tail's first pass

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, plus the paged reopen from efficiency report 0690.

### Tasks

2. **A reopen in a real container**: prove the bounded read through a real `docker exec`. From report 0690, task 1 ("Bound the reopen read"). Status: open.
3. **The poll tail's first pass**: decide whether the one whole-file pass per session needs a cheaper form. Found while doing report 0690, task 1. Status: blocked (waits on 7568: 5120 task 1).

### 2. A reopen in a real container

**Problem.** The bounded read was proven through a fake `docker` on PATH and live in a browser on a local environment, but not against a real container.

**Context.** Report 0690, task 1, is about the read through `docker exec`. `transcriptWindowCommand` (`tmux-shared.ts`) is what runs in the container. It relies on `wc -c` taking a regular file's size from `fstat` and `tail -c +N` seeking, on the image's coreutils.

**Investigation.** `tmux-transcript-reader.test.ts` runs the script under a real `/bin/sh` and compares its bytes with the local read. `apps/backend/scripts/tmux-reopen-read-size.ts` counts the bytes crossing a fake `docker`: 36,853,890 in 2 execs before, 524,306 in 1 exec after, on the 37 MB workload. Browser QA on a local `dev:test` profile with an 8.9 MB transcript read 523,626 bytes on reopen, paged back to the first message in 16 further reads, and kept the task row's state. No container environment was run, so that read has not been timed on a real image or seen in a container tab.

**Decisions.**

- **How to qualify it?**
  - **One browser pass on a `--fixture-environments local,container` profile (recommended).**
    - Pros: the path a user takes, including the first-pass catch-up.
    - Cons: builds the workspace image, so it is slow.
  - **A focused `docker exec` test against the built image, like `tmux-hook-signal-docker.test.ts`.**
    - Pros: repeatable, and it can assert the bytes.
    - Cons: does not cover the tab.

### 3. The poll tail's first pass

**Problem.** The poll loop's tail still reads a transcript from its start once per session in each backend process, and emits every line over the event stream. For a resumed 37 MB session that is one 37 MB read and 9,000 events after each backend restart.

**Context.** This is not a per-reopen cost, and report 0690 did not name it. It is what keeps the task list and the snapshot history correct, and a page read that gets there first pays it instead of the tail, never as well as it (`readPage`). The workload's "first pass owed" column shows the cost: 37,378,196 bytes.

**Investigation.** `TranscriptTail` starts at offset 0 and `drainTail` hands each line to the session's `publishTranscriptLine`. A mounted tab receives those lines as live events. Nothing else needs them, because a tab's own read is the tail page. How often it matters depends on how often sessions are resumed, which the reopen-rate reading on the manual-test checklist (7568: 5120 task 1) should show.

**Decisions.**

- **What to do about it?**
  - **Leave it until the reopen rate (7568: 5120 task 1) shows it matters (recommended).**
    - Pros: no new state; a backend restart is rare.
    - Cons: a resumed long session keeps its one expensive pass.
  - **Scan for task lines only on the first pass and stop emitting history.**
    - Pros: the read and the events shrink for the common session.
    - Cons: a tab mounted across the resume relies on its page read for history; the scan must still see every task call, so a container read stays whole-file unless filtered there.
  - **Persist the snapshot history and tracker state per session.**
    - Pros: a restart resumes from an offset, with no pass at all.
    - Cons: a new stored format with downgrade behaviour, for an unmeasured cost.

## Current state

Transcript sizes were measured on one host on 2026-11-04, by file size only: 3,976 Claude transcripts (native and tmux mixed), median 171 KB, 90th percentile 2.1 MB, 99th percentile 6.4 MB, longest 37 MB. A tab reopen reads one bounded page; earlier history pages in; the task list and per-call snapshots stay correct. Unit, command and renderer tests cover this, plus a live local browser pass. See to-do 1202 task 8 (retired 2026-11-10).

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, reopen rates and sizes from a machine that uses tmux tabs) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, task 8 (retired 2026-11-10)
- Efficiency report, F (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), BG-14
- [Version compatibility register](../../architecture/version-compatibility.md#register)
