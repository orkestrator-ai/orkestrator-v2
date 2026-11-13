# Reproduce Bun's lost child event on the old pipe capture, with a strict probe

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.
Updated 2026-11-11 against `main` at `14df96544`: the Linux half of task 1
reproduced on beelink2; macOS and the reduction remain.
Updated 2026-11-13 against `main` at `17d28238c`: the macOS half of task 1
reproduced on arktech-mini, and task 2 ruled out a watch helper and aborts as
the trigger. Corrected the same day: the schedule replays did not rebuild the
test's repository, so they rule nothing out (see "Task 2: the first replays
were not the recorded workload" below); `reduction.ts` now does, and the abort
step was re-run on it.

### Tasks

1. **Reproduce on the old pipe capture**: run the real test on a scratch copy of the pipe-based `runCommand` with the strict probe, on macOS and on Linux. Status: done (Linux 2026-11-11: 47 lost `close` events in 100 runs; macOS 2026-11-13: 4 lost `exit` and 3 lost `close` events in 100 runs).
2. **Reduce it from there**: delete from that test until the loss stops, then rebuild it as a standalone script. Status: open (2026-11-13: test 1 alone still loses events; a watch helper and aborts racing the exit do not trigger it standalone; the first replays of test 1's commands were not faithful and are void, so next, record test 1 again and replay it faithfully with `reduction.ts replay`, with and without the harness, before deleting service calls).

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
- **What if macOS does not reproduce?** (Moot since 2026-11-13: it reproduced.)
  - **Record it, and narrow the macOS half of the upstream report to the 2026-11-04 traces (recommended).**
    - Pros: honest about what is current; the Linux half now has a current reproduction.
    - Cons: a weaker macOS claim.
  - **Keep searching with more load.**
    - Pros: case 1537's macOS rows used 36 CPU hogs.
    - Cons: open-ended, and hogs on the user's command node are disruptive.

**macOS, 2026-11-13**, on arktech-mini (macOS 27.2, arm64, 18 cores, Bun 1.4.4), natively. Host load average was 20 to 121 throughout, from the other builds sharing the host; no CPU hogs were added. The scratch copy was again a throwaway `git worktree` (under this worktree's git-ignored `output/`, never committed, removed afterwards) whose `runCommandBytes` called the old pipe capture with the git output-close grace, the lost-exit watchdog and the reaper removed. The probe is now committed as `scripts/lost-child-event/probe.ts` with its `bun test` preload (`preload.ts`): it picks `waitid` from `libSystem` (flags `0x25`, `si_pid` the fourth int) or `libc` (flags `0x01000005`, the fifth), lists this process's descriptors from `/dev/fd` or `/proc/self/fd`, and records the group's state and a zero-timeout `poll()` of our ends at a lost `close`; the cross-process descriptor scan is Linux-only and was dropped. On macOS too, `node:child_process` makes `stdio: "pipe"` three Unix sockets.

Controls, all passing on macOS: a child held between `spawn` and a busy-wait reads as a zombie twice and its `exit` still arrives; the ends of a child whose EOF the blocked loop has not read poll `IN|HUP`; and `sh -c 'sleep 7 & exit 0'` is flagged `LOST_CLOSE` with its group alive and its output ends polling `none`, then closes at 7.0 s.

The real test on the pipe capture, 100 runs, one at a time:

| Measure | Result |
| --- | --- |
| Test runs passed | 100 of 100 |
| Children tracked | 10,297 |
| Lost `exit` (unreaped zombie for 5 s) | **4, in 4 runs**: `git rev-parse` 2, `config` 1, and one recorded before the probe named subcommands. Each became a zombie 49 to 74 ms after spawn and **was still an unreaped zombie when the process exited**, 30 s later: Bun never delivered its `exit`, even after the command's own timeout had destroyed its streams |
| Lost `close` (no `close` 5 s after `exit`) | **3, in 2 runs**: `git merge-base` 2, `rev-parse` 1. Each had its group gone and our stdout end polling `IN\|HUP` (an EOF nothing read), and closed only when the command's timeout destroyed the streams (2 at about 30 s, 1 at about 10 s) |
| Slow but delivered | 1 `exit` (`git init`) 110 ms after the zombie appeared |
| Where | All 7 in test 1, "saved/reset overrides retarget real scans …", as on Linux |

So macOS shows both symptoms on the pipe capture, and the lost `exit` is the macOS-specific one that case 1537's traces showed (`Z <defunct>` with no `exit`): the kernel holds the zombie and Bun never reaps it. The lost `close` matches Linux exactly: an EOF the kernel reports and Bun does not deliver. The rate (7 in 10,297 children) is well below beelink2's (47 in 10,175).

### 2. Reduce it from there

**Problem.** A reproduction inside the real test is not something Bun's maintainers can run.

**Context.** The real test brings a public API harness, SQLite storage, the diff-stats service with its watchers and admission pool, real Git with a `git clone`, and a nested `bun test`. Task 2 of to-do 4260 rebuilt the test's command pattern standalone with a watched repository, `bun:sqlite`, nested `bun` children and clones, and lost nothing in about 415,000 children, all on macOS.

**Investigation.** Started 2026-11-11 on Linux, after task 1's Linux half:

- **The standalone script on Linux.** 4260's `lost-child-event-probe.ts`, ported to Linux (`libc.so.6`, flags `0x01000005`, `si_pid` as the fifth int), with `capture=pipe`: 0 lost in 1,260 children, then 0 in 21,000 twice (5,000 iterations each, 68 s and 86 s); 0 in 21,000 run inside a `bun test` file; 0 in 21,000 with stdin opened as a pipe and ended, as the old `runCommand` did. About 85,000 children, none lost, at the same host load as the real test's 47.
- **Which test loses them.** The file has four tests, and the preload numbered them as they started. In 20 more runs (2,021 children) all 11 lost `close` events, in 10 runs, were children spawned during the first test, "saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base", the only one that runs real Git through the backend's services. Most were reported while a later test was running, so the stalled children outlive the scan that started them.

So the trigger is in what that test brings and the script lacks: the public API harness and its storage, and the diff-stats service's watchers, admission pool and scan retargeting. That is where to delete from next.

**macOS, 2026-11-13.** Each step ran 100 times, against the same pipe-capture copy and strict probe as task 1. The probe recorded test 1's spawn schedule (98 children: every command, its working directory and its offset from the first spawn) so it could be replayed without the services that produced it. That recording held nothing else, which made the three replay rows below void, and the first abort row ran on a script that could abort its own fixture; both are explained after the table:

| Step | Children | Lost | Runs with a loss |
| --- | --- | --- | --- |
| Test 1 alone (`-t saved/reset`) | 10,151 | **12**: 9 `exit`, 3 `close` | 8 of 100 |
| Test 1 alone, with the capture marking any child it aborted or timed out (80 runs) | 8,191 | **12**: 7 `exit`, 5 `close` | 12 of 80 |
| Void: test 1's recorded schedule replayed inside `bun test` through the same scratch `runCommand`, the public API harness created first and left idle | 9,800 | 0 | 0 |
| Void: the same replay without the harness | 9,800 | 0 | 0 |
| Void: the same replay standalone (the first `reduction.ts replay`, 300 times) | 29,400 | 0 | — |
| 4260's command pattern standalone, with a long-lived `bun -e` watch helper on pipes, as the backend's macOS watch helper (`reduction.ts pattern --host`, twice 3,000 iterations) | 36,600 | 0 | — |
| Superseded: the pattern with half the children SIGKILLed and their streams destroyed 0 to 80 ms after spawn, as an aborted scan is (the first `reduction.ts pattern --abort=80`, setup abortable, outcomes unchecked) | 12,200 | 0 | — |
| Re-run on the fixed script: the fixture never aborted and checked, half the scan children (the five scans and the clone) picked for a SIGKILL 0 to 80 ms after spawn; 708 were still running when it fired and were killed, 25 `index.lock` files a killed `status` left were removed, 0 scans failed unexpectedly (`reduction.ts pattern 2400 --abort=80`, host load about 5) | 14,644 | 0 | — |

**Why the replays are void.** The recorded schedule held only argv, working directory and offset. The replay created an empty directory layout and a single `# comparison` README, so it never made the test's own file writes (`unpushed base`, `dirty`, `dirty again`), never passed the Git identity the harness gives its commits through the environment, and passed the recorded commit ids, which do not exist in a fresh repository, to the later `diff`, `checkout` and `cat-file` calls. Its `run()` ignored every exit status. A replay of a schedule shaped like test 1 with its writes withheld fails 15 of its 19 commands (exit 1 or 128), so most of the 98 replayed commands most likely failed early, and the zero says nothing about whether test 1's commands alone are enough. That question is open again.

**Why the first abort row is superseded.** The first `--abort` applied to every spawn, the fixture's `git init`, `add` and `commit` included, and ignored exit statuses, so a run whose commit was killed scanned an unborn repository without saying so. `reduction.ts` now never aborts the fixture's commands and fails if one of them fails, removes the `index.lock` a killed `status` leaves before the per-iteration `checkout` (which would otherwise fail), and exits 1 if any scan that was not aborted failed. The re-run row above is on that script. It also shows that "half the children" overstated what the first row aborted: a child is killed only if it is still running when its timer fires, which was 708 of the 12,240 scan children (about 6%) in the re-run. Before the fix, each of its 25 stale locks would have failed that iteration's `checkout` without a word. The watch helper row ran without aborts, so its fixture was intact, but its outcomes were not checked either.

In the marked runs no lost child had been aborted or had timed out when it was lost; the capture's abort path never ran at all, and 11 other children timed out. Every lost child whose position was recorded (10 of 12) was among the test's later spawns, the 66th to the 100th of about 100, from about the replacement checkout's `git clone` on, which matches 4260's note that a stuck child was spawned just before the clone exited.

So on macOS the trigger is neither a watch helper nor an abort racing the exit. Whether the commands and their timing are enough on their own, or the test's service calls between them are needed (the diff-stats service's scans and their admission pool, `set_environment_diff_base` and the other commands through the harness, storage writes, and the environment's worktree watch), needs a faithful replay. The probe now records one: every command's exit status, the revision it printed, its Git identity variables, which earlier children were still running when it started, and the test's file writes (`preload.ts`). `reduction.ts replay` makes those writes, waits for whatever had finished first in the recording, substitutes each recorded revision with the one its own command printed, refuses a schedule recorded before this, and exits 1 on any command that ends differently from the recording. A schedule recorded from a scratch fixture shaped like test 1's Git use (22 entries: 19 commands, 3 writes, 3 revisions) replayed 20 times with 0 mismatches.

The scripts are committed as `scripts/lost-child-event/` (`probe.ts`, `preload.ts`, `reduction.ts`) so the next step can start from them. `reduction.ts` is also what to attach to the upstream report as the non-reproducing reduction.

**Decisions.**

- **How to reduce?**
  - **Delete one service at a time from the reproducing test, with the strict probe (recommended).**
    - Pros: each step is a direct comparison against a known rate. At about one loss in two runs on beelink2, 20 runs per step tell a rate of zero from the baseline (10 of 20 runs had a loss).
    - Cons: each step needs the test to still drive the code that spawns, so some deletions need a stand-in.
  - **Add the remaining real-test ingredients to the standalone script.**
    - Pros: the result is directly reportable.
    - Cons: about 1.2 million children across macOS and Linux without a loss, and no signal yet about which ingredient to add.
- **Where to run the next step?** (2026-11-13)
  - **Linux on beelink2, deleting the test's service calls one at a time (recommended).**
    - Pros: about one loss in two runs there, so 20 runs a step suffice.
    - Cons: the faithful replay still has to run first (record test 1 there with the preload, then `reduction.ts replay` and the in-test replay, with and without the harness), and the macOS symptom (a lost `exit`) is checked only at the end.
  - **macOS on arktech-mini.**
    - Pros: tests the platform-specific lost `exit` directly.
    - Cons: 8 runs in 100 with a loss, so each step needs about 100 runs (about 10 minutes) to tell zero from the baseline.
- **Which call to delete first?** (2026-11-13)
  - **Replace the diff-stats service's scans (`readFileList` with `refresh`, `diffStats.sync`) with the recorded commands, keeping the harness's commands and storage (recommended).**
    - Pros: they spawn most of the children, and their admission pool and retargeting are what a replay lacks.
    - Cons: the scans also drive the test's assertions, which must be dropped for that step.
  - **Drop the harness commands (`set_environment_diff_base` and the rest) first.**
    - Pros: smaller change to the test.
    - Cons: those commands start the scans, so the step removes both at once and says less.

## Current state

Task 1 reproduced the loss on Linux (2026-11-11) and on macOS (2026-11-13), above. Task 2 is open: on macOS the loss is not triggered by a watch helper or by aborts; whether it needs test 1's service calls or only its commands waits on a faithful replay, which the probe and `reduction.ts` now support. To-do 4260's task 6 reaper already removes a macOS zombie that Bun never reports, and `runCommand` no longer waits on a pipe's `close`, so this is about the upstream report, not about this repository's behaviour.

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

### Task 1: the macOS run used a worktree under this build's own `output/` (2026-11-13)

The scratch worktree was created under the build's git-ignored `output/agent-testing/` rather than the system temporary directory, so everything the run made stayed inside the build's own directory and was removed with it. It was never committed, and the pipe capture never reached a pushed branch.

### Task 1: no descendant-holder scan on macOS (2026-11-13)

macOS has no `/proc`, and every way to list another process's descriptors (`lsof`, `proc_pidinfo` across processes) either starts a process or reads other processes' state. The macOS symptom is a lost `exit`, which `waitid(WNOWAIT)` settles on its own, and for a lost `close` the group check (`kill(-pid, 0)` answering `ESRCH`) already shows no descendant is left to hold the output. So the scan was dropped there, and the `sleep 7` control checks the group check tells the cases apart.

### Task 2: replay the recorded schedule before deleting services (2026-11-13)

Deleting services one at a time from test 1 needs a stand-in for each, and at macOS's rate (8 runs in 100 with a loss) each step costs 100 runs. Replaying the exact recorded spawn schedule answers the larger question first, whether the commands alone are enough, at the cost of three runs. The first three replays did not answer it (next subsection), so the choice stands and the replay is still the next step.

### Task 2: the first replays were not the recorded workload (2026-11-13)

Review found that the replay rebuilt only the directory layout: no file writes, no commit identity, recorded commit ids passed to a fresh repository, and no exit status checked, so failed Git commands counted as a replayed workload. It also found that `--abort` could kill the pattern's own fixture. Options:

- **Make the recording and replay faithful, and mark the old rows void (chosen).**
  - Pros: the replay is still the cheapest way to tell commands from services; the record says plainly which rows count.
  - Cons: the in-test replays need the scratch pipe capture again, so they cannot be redone in the same change.
- **Remove replay mode and its claims.**
  - Pros: smaller.
  - Cons: throws away the cheapest next step.

The probe records outcomes, revisions, identity, dependencies and writes only when `LOST_CHILD_PROBE_SCHEDULE` is set; recording a revision adds a `data` listener to the child's stdout, so recording runs are kept apart from measuring runs. Revisions are mapped by the command that printed them rather than by forcing identical commit ids (fixed dates and identity), which would have depended on every byte of every write matching. A schedule from before the change is refused rather than replayed, since it cannot be made faithful.

### Task 2: the scripts are committed, the pipe capture is not (2026-11-13)

4260 kept its probe in the to-do's text. The probe now has a macOS and a Linux path, a preload and two reduction modes, which is more than a to-do should carry, and the upstream report needs a file to attach. They live in `scripts/lost-child-event/`, run nothing at build or test time, and never touch `runCommand`. The pipe capture itself stays out of the repository, as the constraint below requires; the scratch copy is described in task 1.

### Task 2: the reduction started on Linux before the macOS half of task 1 (2026-11-11)

Task 2 depended on task 1 for a reproduction to reduce from. The Linux half gives one, so the first two reduction steps were taken there rather than waiting for a macOS host.

## Related

- To-do 4260 (retired 2026-11-10): the defect and the draft upstream report, in `git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`; the reaper is in [backend runtime](../../architecture/backend-runtime.md#one-shot-commands), and filing the report is in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
- [Flake case 1537](../../tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md)
- `scripts/lost-child-event/`: the strict probe, its `bun test` preload and the standalone reductions (`pattern`, `replay`)

## Replaces

Task 2's recommended next step in to-do 4260, moved here on 2026-11-06.
