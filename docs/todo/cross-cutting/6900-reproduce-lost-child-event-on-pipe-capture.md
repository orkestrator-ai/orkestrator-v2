# Reproduce Bun's lost child event on the old pipe capture, with a strict probe

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **Reproduce on the old pipe capture**: run the real test on a scratch copy of the pipe-based `runCommand` with the strict probe, on macOS and on Linux. Status: open.
2. **Reduce it from there**: delete from that test until the loss stops, then rebuild it as a standalone script. Status: open (depends on 1).

### 1. Reproduce on the old pipe capture

**Problem.** Every real loss of a child's completion event was seen on the pipe-based `runCommand` that task 3 of to-do 4260 (retired 2026-11-10; its record is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`) replaced: on Linux a pipe EOF whose `EPOLLONESHOT` was delivered and never re-armed, on macOS a child left `Z <defunct>` for a whole 10 s with no `exit` event. On 2026-11-06 a strict probe saw no loss at all on today's file capture, so the upstream report has no current reproduction and no reduced case.

**Context.** The strict probe reads the child's zombie state through `waitid(P_PID, pid, WEXITED | WNOHANG | WNOWAIT)` with `bun:ffi`: it starts no process and reaps nothing, so it can neither wake Bun nor change the outcome. A child counts as lost only after 5 s as an unreaped zombie with no `exit`, or 5 s after `exit` with no `close`. The single `ps` look the watchdog makes counts exits Bun reports milliseconds later as losses. In 150 runs of `apps/backend/src/core/diff-base-override.integration.test.ts` on file capture (macOS, host load 35 to 60), it saw 0 losses and 3 exits delivered 22 to 30 ms after the zombie appeared, while the watchdog's own count was 10. The probe and the standalone script are in to-do 4260's task 2, "Outcome (2026-11-06)", in `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`. The pipe capture is in history before `51ccfb3f2`.

**Investigation.** Not started. The 2026-11-04 stress table in [case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md#load-and-stress-runs-2026-11-03-to-2026-11-04) gives the old pipe capture 20 stalled children in 100 Linux runs and `Bun.spawn` eager pipes 121 in 150, but those used a probe "unsettled 1 s after exit, or a zombie with no exit event", which on macOS includes the delivery window. Linux's count (EOF missing a second after `exit`) is not affected by that window.

**Decisions.**

- **Where to run the old capture?**
  - **A scratch branch that restores the pipe capture in `command-capture.ts` only, never pushed (recommended).**
    - Pros: the real test unchanged; nothing reaches `main`; the strict probe drops in where the watchdog is.
    - Cons: the restore has to follow later edits to `command-capture.ts`, and the macOS watchdog has to be disabled for the run or it settles the command first.
  - **Copy the old capture into a standalone harness that imports the backend's services.**
    - Pros: no branch.
    - Cons: it is not the real test, which is the only thing that has reproduced.
- **What if it does not reproduce?**
  - **Record it, and narrow the macOS half of the upstream report to the 2026-11-04 traces (recommended).**
    - Pros: honest about what is current.
    - Cons: a weaker report.
  - **Keep searching with more load.**
    - Pros: case 1537's macOS rows used 36 CPU hogs.
    - Cons: open-ended, and hogs on the user's command node are disruptive.

### 2. Reduce it from there

**Problem.** A reproduction inside the real test is not something Bun's maintainers can run.

**Context.** The real test brings a public API harness, SQLite storage, the diff-stats service with its watchers and admission pool, real Git with a `git clone`, and a nested `bun test`. Task 2 of to-do 4260 rebuilt the test's command pattern standalone with a watched repository, `bun:sqlite`, nested `bun` children and clones, and lost nothing in about 415,000 children.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **How to reduce?**
  - **Delete one service at a time from the reproducing test, 100 runs per step with the strict probe (recommended).**
    - Pros: each step is a direct comparison against a known rate.
    - Cons: slow if the rate is low; each step needs enough runs to tell a lower rate from noise.
  - **Add the remaining real-test ingredients to the standalone script.**
    - Pros: the result is directly reportable.
    - Cons: it has not reproduced in about 1.1 million children with no signal about what to add.

## Current state

Nothing done. To-do 4260's task 6 reaper already removes a macOS zombie that Bun never reports, so this is about the upstream report, not about this repository's behaviour.

## Constraints and rationale

- Run on an isolated checkout or throwaway directory only; never against the real data directory.
- Do not leave the pipe capture on any pushed branch.
- Do not add CPU hogs on the user's command node without asking.

## Related

- To-do 4260 (retired 2026-11-10): the defect and the draft upstream report, in `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`; the reaper is in [backend runtime](../../architecture/backend-runtime.md#one-shot-commands), and filing the report is in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)

## Replaces

Task 2's recommended next step in to-do 4260, moved here on 2026-11-06.
