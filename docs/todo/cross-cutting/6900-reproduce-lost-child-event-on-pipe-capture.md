# Reproduce Bun's lost child event on the old pipe capture, with a strict probe

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.
Updated 2026-11-11 against `main` at `14df96544`: the Linux half of task 1
reproduced on beelink2; macOS and the reduction remain.

### Tasks

1. **Reproduce on the old pipe capture**: run the real test on a scratch copy of the pipe-based `runCommand` with the strict probe, on macOS and on Linux. Status: open (Linux done 2026-11-11, reproduced: 47 lost `close` events in 100 runs; the macOS half needs a macOS host).
2. **Reduce it from there**: delete from that test until the loss stops, then rebuild it as a standalone script. Status: open (started 2026-11-11 on Linux: the standalone script does not reproduce, and every loss comes from the file's one real-Git test).

### 1. Reproduce on the old pipe capture

**Problem.** Every real loss of a child's completion event was seen on the pipe-based `runCommand` that task 3 of to-do 4260 (retired 2026-11-10; its record is `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`) replaced: on Linux a pipe EOF whose `EPOLLONESHOT` was delivered and never re-armed, on macOS a child left `Z <defunct>` for a whole 10 s with no `exit` event. On 2026-11-06 a strict probe saw no loss at all on today's file capture, so the upstream report had no current reproduction and no reduced case.

**Context.** The strict probe reads the child's zombie state through `waitid(P_PID, pid, WEXITED | WNOHANG | WNOWAIT)` with `bun:ffi`: it starts no process and reaps nothing, so it can neither wake Bun nor change the outcome. A child counts as lost only after 5 s as an unreaped zombie with no `exit`, or 5 s after `exit` with no `close`. The single `ps` look the watchdog makes counts exits Bun reports milliseconds later as losses. In 150 runs of `apps/backend/src/core/diff-base-override.integration.test.ts` on file capture (macOS, host load 35 to 60), it saw 0 losses and 3 exits delivered 22 to 30 ms after the zombie appeared, while the watchdog's own count was 10. The probe and the standalone script are in to-do 4260's task 2, "Outcome (2026-11-06)", in `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`. The pipe capture is `executeCommandBytes` in `git show 96ee1eb3e:apps/backend/src/core/shell.ts` (lines 243 to 405), the parent of `8d4dde565`, which moved `runCommand` to file capture.

**Investigation.** Linux done 2026-11-11 on beelink2 (x86_64, 16 cores, Bun 1.4.4, git 2.56.0), natively rather than in a container. Host load average was 41 to 61 throughout, all of it other worktrees' suites; no CPU hogs were added.

The scratch copy was a throwaway `git worktree` under the temporary directory, never committed or pushed, and removed afterwards. In `packages/protocol/src/node/command-capture.ts` (where `runCommand` lives now) `runCommandBytes` called a copy of the old pipe `executeCommandBytes` instead of the file capture: `node:child_process` with `stdio: "pipe"`, settling on `close`, with the output limits adapted to today's options. Removed from the copy so that nothing settles a command before the probe sees it: the git output-close grace (which fails a git command 5 s after `exit`), the lost-exit watchdog and the reaper. Each child was registered with a probe module, and a `bun test` preload held the process after the last test until every tracked child had closed, up to 30 s, so a late `close` was still seen.

On Linux, Bun's `node:child_process` implements `stdio: "pipe"` as Unix socketpairs and watches the child's exit through a pidfd (`/proc/self/fd` after a spawn: three `socket:` entries and one `anon_inode:[pidfd]`). So a lost `close` here is an EOF on a socket that is not delivered, which matches the 2026-11-04 fdinfo. At each `LOST_CLOSE` the probe also recorded, without starting a process or reading any stream:

- whether the child's process group still existed (`kill(-pid, 0)`);
- which processes held the child's ends of its sockets (inodes read from `/proc/<pid>/fd/1` and `2` at spawn, then a scan of `/proc/*/fd`);
- `poll()` with a zero timeout on this process's own ends, recorded at spawn by comparing `/proc/self/fd` before and after the synchronous `spawn`. `IN|RDHUP|HUP` there means the kernel already reports EOF and nothing has read it.

Controls, all passing: a child held between `spawn` and a busy-wait reads as a zombie twice and is not reaped by the look; a socket end whose EOF the blocked event loop has not read polls `IN|RDHUP|HUP`; and `sh -c 'sleep 7 & exit 0'`, whose background `sleep` keeps the output open, is flagged `LOST_CLOSE` with its group alive and its ends polling `none`, then closes at 6.99 s. So the probe tells a descendant holding the output apart from an EOF Bun did not deliver.

The real test on the pipe capture, 100 runs (`bun test --preload ../../tests/setup-node.ts --preload <probe preload> src/core/diff-base-override.integration.test.ts` from `apps/backend`, one at a time):

| Measure | Result |
| --- | --- |
| Test runs passed | 100 of 100 |
| Children tracked | 10,175 |
| Lost `exit` (unreaped zombie for 5 s) | **0**; 2 exits delivered 144 to 145 ms after the zombie was first seen |
| Lost `close` (no `close` 5 s after `exit`) | **47, in 42 runs**: `git for-each-ref` 16, `rev-parse` 15, `merge-base` 9, `config` 3, `diff` 2, `status` 2 |
| Of those, group gone, no process holding the child's ends, and our ends polling `IN\|RDHUP\|HUP` | 47 of 47 |
| When the `close` came | 43 at the command's own timeout (18 at about 10 s, 25 at about 30 s), when the timeout destroyed the streams; 4 not within the 30 s hold |

So every lost `close` was a real loss: the child had exited, nothing else held its output, the kernel reported EOF on our end, and Bun delivered no `close` until something else destroyed the streams. The tests still passed because the commands that stalled were not ones the test waited on; this matches case 1537's finding that the stalled children belonged to superseded scans. Linux reproduced at a higher rate than case 1537's container (20 stalled children in 100 runs, aarch64, 4 CPUs).

**Decisions.**

- **Where to run the old capture?**
  - **A scratch worktree that restores the pipe capture in `command-capture.ts` only, never pushed (recommended, done for Linux).**
    - Pros: the real test unchanged; nothing reaches `main`; the strict probe drops in where the watchdog is.
    - Cons: the restore has to follow later edits to `command-capture.ts`, and the macOS watchdog has to be disabled for the run or it settles the command first.
  - **Copy the old capture into a standalone harness that imports the backend's services.**
    - Pros: no branch.
    - Cons: it is not the real test, which is the only thing that has reproduced.
- **What if macOS does not reproduce?**
  - **Record it, and narrow the macOS half of the upstream report to the 2026-11-04 traces (recommended).**
    - Pros: honest about what is current; the Linux half now has a current reproduction.
    - Cons: a weaker macOS claim.
  - **Keep searching with more load.**
    - Pros: case 1537's macOS rows used 36 CPU hogs.
    - Cons: open-ended, and hogs on the user's command node are disruptive.

What remains: the macOS half, on a macOS host. The probe needs three changes there: `waitid` from `/usr/lib/libSystem.B.dylib` with flags `0x25` and `si_pid` as the fourth int; no `/proc`, so the descriptor ownership and `poll` checks need `proc_pidinfo` or `lsof`-free equivalents, or can be dropped since a lost `exit` is the macOS symptom; and the macOS watchdog and reaper removed from the copy as on Linux.

### 2. Reduce it from there

**Problem.** A reproduction inside the real test is not something Bun's maintainers can run.

**Context.** The real test brings a public API harness, SQLite storage, the diff-stats service with its watchers and admission pool, real Git with a `git clone`, and a nested `bun test`. Task 2 of to-do 4260 rebuilt the test's command pattern standalone with a watched repository, `bun:sqlite`, nested `bun` children and clones, and lost nothing in about 415,000 children, all on macOS.

**Investigation.** Started 2026-11-11 on Linux, after task 1's Linux half:

- **The standalone script on Linux.** 4260's `lost-child-event-probe.ts`, ported to Linux (`libc.so.6`, flags `0x01000005`, `si_pid` as the fifth int), with `capture=pipe`: 0 lost in 1,260 children, then 0 in 21,000 twice (5,000 iterations each, 68 s and 86 s); 0 in 21,000 run inside a `bun test` file; 0 in 21,000 with stdin opened as a pipe and ended, as the old `runCommand` did. About 85,000 children, none lost, at the same host load as the real test's 47.
- **Which test loses them.** The file has four tests, and the preload numbered them as they started. In 20 more runs (2,021 children) all 11 lost `close` events, in 10 runs, were children spawned during the first test, "saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base", the only one that runs real Git through the backend's services. Most were reported while a later test was running, so the stalled children outlive the scan that started them.

So the trigger is in what that test brings and the script lacks: the public API harness and its storage, and the diff-stats service's watchers, admission pool and scan retargeting. That is where to delete from next.

**Decisions.**

- **How to reduce?**
  - **Delete one service at a time from the reproducing test, with the strict probe (recommended).**
    - Pros: each step is a direct comparison against a known rate. At about one loss in two runs on beelink2, 20 runs per step tell a rate of zero from the baseline (10 of 20 runs had a loss).
    - Cons: each step needs the test to still drive the code that spawns, so some deletions need a stand-in.
  - **Add the remaining real-test ingredients to the standalone script.**
    - Pros: the result is directly reportable.
    - Cons: about 1.2 million children across macOS and Linux without a loss, and no signal yet about which ingredient to add.

## Current state

Task 1's Linux half reproduced the loss on 2026-11-11 (above); its macOS half and task 2 are open. To-do 4260's task 6 reaper already removes a macOS zombie that Bun never reports, and `runCommand` no longer waits on a pipe's `close`, so this is about the upstream report, not about this repository's behaviour.

## Constraints and rationale

- Run on an isolated checkout or throwaway directory only; never against the real data directory.
- Do not leave the pipe capture on any pushed branch.
- Do not add CPU hogs on the user's command node without asking.

## Assumptions and decisions

### Task 1: the Linux run was native on beelink2, not in a 4-CPU container (2026-11-11)

Case 1537's Linux rows ran in an `oven/bun:1.4.4` container with `--cpus=4`. This run used the host directly: the session has no access to the host's Docker daemon, and the native run reproduced at once, so a container was not needed to show the loss. Its rate (47 in 100 runs) is therefore not directly comparable with 1537's (20 in 100).

### Task 1: the probe checks who holds the output before counting a loss (2026-11-11)

"No `close` 5 s after `exit`" also fits a descendant that legitimately keeps the output open. Each loss was therefore recorded with the process group's state, the holders of the child's socket ends and a zero-timeout `poll()` of this process's ends, and a control with a background `sleep` checks that such a case reads differently. All 47 losses read as an undelivered EOF.

### Task 1: the process is held up to 30 s after the last test (2026-11-11)

The 2026-11-06 hold was 7 s, long enough to report a loss but not to see whether its `close` ever came. A 30 s hold showed that 43 of 47 came only when the command's own timeout destroyed the streams, which separates a lost event from a slow one.

### Task 2: the reduction started on Linux before the macOS half of task 1 (2026-11-11)

Task 2 depended on task 1 for a reproduction to reduce from. The Linux half gives one, so the first two reduction steps were taken there rather than waiting for a macOS host.

## Related

- To-do 4260 (retired 2026-11-10): the defect and the draft upstream report, in `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`; the reaper is in [backend runtime](../../architecture/backend-runtime.md#one-shot-commands), and filing the report is in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)

## Replaces

Task 2's recommended next step in to-do 4260, moved here on 2026-11-06.
