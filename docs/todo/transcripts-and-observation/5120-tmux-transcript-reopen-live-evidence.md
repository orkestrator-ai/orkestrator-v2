# Tmux transcript reopen: live evidence and the tail's first pass

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c` (first analysed 2026-11-04 against `e198fd4a7`, plus the paged reopen from efficiency report 0690).

### Tasks

2. **A reopen in a real container**: prove the bounded read through a real `docker exec`. From report 0690, task 1 ("Bound the reopen read"). Status: done (2026-11-13, `tmux-transcript-reopen-docker.test.ts` on the environment image).
3. **The poll tail's first pass**: decide whether the one whole-file pass per session needs a cheaper form. Found while doing report 0690, task 1. Status: blocked (waits on 7568: 5120 task 1).

### 2. A reopen in a real container

**Problem.** The bounded read was proven through a fake `docker` on PATH and live in a browser on a local environment, but not against a real container.

**Context.** Report 0690, task 1, is about the read through `docker exec`. `transcriptWindowCommand` (`tmux-shared.ts`) is what runs in the container. It relies on `wc -c` taking a regular file's size from `fstat` and `tail -c +N` seeking, on the image's coreutils.

**Investigation.** `tmux-transcript-reader.test.ts` runs the script under a real `/bin/sh` and compares its bytes with the local read. `apps/backend/scripts/tmux-reopen-read-size.ts` counts the bytes crossing a fake `docker`: 36,853,890 in 2 execs before, 524,306 in 1 exec after, on the 37 MB workload. Browser QA on a local `dev:test` profile with an 8.9 MB transcript read 523,626 bytes on reopen, paged back to the first message in 16 further reads, and kept the task row's state.

2026-11-13, in a real container: `apps/backend/tests/tmux-transcript-reopen-docker.test.ts` (opt-in, `RUN_LIVE_DOCKER_TESTS=1` and `ORKESTRATOR_QUALIFICATION_IMAGE`) runs the real `TmuxSession` and `TmuxBackend` against a container of the environment image built from `17d28238c`, on a disposable rootless Docker Engine 29.9.2 (`mise run docker:disposable`), with the 37 MB workload's transcript (9,000 records of 4 KiB, 36,853,890 bytes) copied into the container's Claude home. It counts every `docker exec` and the stdout bytes it returned. Three runs passed:

- The first read in the backend process, which owes the tail's one pass: 37,378,196 bytes in 2 execs.
- The reopen of the running session: 524,306 bytes in 1 exec (56 ms and 171 ms on a shared, busy host), 128 records, the same records and cursor a local read of the same file returns. The image's own `sh`, `wc` and `tail` cut the page.
- Paging back: 70 further reads to the first record, each one exec of at most 524,306 bytes, and every record seen once in order.
- A missing transcript answers an empty page.

The bound (`TMUX_TRANSCRIPT_PAGE_BYTES` plus the size header) is asserted on every read. Evidence and the command are in [container qualification](../../development/container-qualification.md#tmux-reopen-static-search-text-and-streamed-reads-in-real-containers-2026-11-13).

**Decisions.**

- **How to qualify it?**
  - **One browser pass on a `--fixture-environments local,container` profile.**
    - Pros: the path a user takes, including the first-pass catch-up.
    - Cons: builds the workspace image, so it is slow; this host's account cannot reach the host Docker daemon, so the profile would have to be pointed at a disposable one.
  - **A focused `docker exec` test against the built image, like `tmux-hook-signal-docker.test.ts` (recommended; done 2026-11-13).**
    - Pros: repeatable, and it can assert the bytes on every read.
    - Cons: does not cover the tab; the tab's own page handling is the same code the local browser pass already exercised.

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

Transcript sizes were measured on one host on 2026-11-04, by file size only: 3,976 Claude transcripts (native and tmux mixed), median 171 KB, 90th percentile 2.1 MB, 99th percentile 6.4 MB, longest 37 MB. A tab reopen reads one bounded page; earlier history pages in; the task list and per-call snapshots stay correct. Unit, command and renderer tests cover this, plus a live local browser pass and, since 2026-11-13, a reopen through a real `docker exec` on the environment image (task 2). See to-do 1202 task 8 (retired 2026-11-10).

## Assumptions and decisions

### Task 2: a focused `docker exec` test rather than a container tab

The recommended browser pass needs a profile whose backend can reach Docker; this host's account cannot reach the host daemon, and the ticket allows Docker only through a disposable daemon. The bound is a property of the container read, which the test asserts byte for byte on every read, while the tab's paging is shared with the local path the 2026-11-04 browser pass covered. So the test was written and run instead, and kept as an opt-in suite so the read can be re-run on any later image.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, reopen rates and sizes from a machine that uses tmux tabs) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, task 8 (retired 2026-11-10)
- Efficiency report, F (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), BG-14
- [Version compatibility register](../../architecture/version-compatibility.md#register)
