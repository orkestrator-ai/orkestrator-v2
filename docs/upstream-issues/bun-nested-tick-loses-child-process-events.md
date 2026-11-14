# Bun: a nested event-loop tick loses child-process completion events

**Tracker:** Bun, <https://github.com/oven-sh/bun/issues> (bug report)
**Status:** draft
**Source:** 4260 (retired) task 1, "Draft report" (`git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`); [6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md) task 3 (cause), tasks 1 and 4; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; reproduction [`nested-tick.ts`](../../scripts/lost-child-event/nested-tick.ts) and [`probe.ts`](../../scripts/lost-child-event/probe.ts)
**Filed:** —

## Issue text

**Title:** `bun test`: an awaited `expect(promise).resolves`/`.rejects` drops another child process's pipe EOF (`close` never fires)

**Summary.** An awaited `expect(promise).resolves` or `.rejects` settles the promise by running the event loop from inside the current callback (`waitForPromise`). That nested tick overwrites the outer tick's `ready_polls`, `num_ready_polls` and `current_ready_poll`, so the outer dispatch skips the rest of its ready events. Bun's own comment above `PROCESS_POLL_ONE_SHOT` in `src/spawn/process.rs` describes this, and the Linux pidfd was made level-triggered for it. A child's stdout and stderr readers are still one-shot polls, so a skipped pipe EOF is never seen again and the child's `close` never fires.

**Reproduction.** Attached: `nested-tick.ts` (a `bun test` file) and `probe.ts` (its strict probe; it reads zombie state with `waitid(WNOWAIT)` and `poll()` with a zero timeout, so it starts no process and reaps nothing). Each iteration spawns two `true` children on pipes, waits for the first to close, then awaits `expect(run(["false"])).rejects.toThrow()`.

```sh
LOST_CHILD_PROBE_OUT=<absolute path>/out.jsonl LOST_CHILD_NESTED_MODE=rejects \
  LOST_CHILD_NESTED_ITERATIONS=1000 bun test ./nested-tick.ts
```

Result on Linux x86-64 (16 cores, Linux 7.2.15, Bun 1.4.4), 1,000 iterations each:

| `LOST_CHILD_NESTED_MODE` | Children | Lost `close` |
| --- | --- | --- |
| `rejects`: `await expect(run(["false"])).rejects.toThrow()` | 3,000 | 91 |
| `resolves`: `await expect(run(["true"])).resolves.toBeUndefined()` | 3,000 | 98 |
| `sleep`: `await expect(Bun.sleep(1)).resolves.toBeUndefined()` (spawns nothing) | 2,000 | 116 |
| `plain`: `await run(["false"]).catch(...)` (no `expect`) | 3,000 | 0 |
| `rejects` with no second child (`LOST_CHILD_NESTED_OTHERS=0`) | 2,000 | 0 |

Every lost child was the second one, never the awaited one. At each loss: the child's process group was gone; our ends of its stdout/stderr sockets polled `IN|HUP` (EOF nothing read); `/proc/self/fdinfo` showed their epoll registrations as `events: 40000000` (`EPOLLONESHOT`, no interest left); the JS stream was flowing, empty, not ended, not destroyed, with its `data` listener. The `exit` event always arrived on Linux.

**In a real test suite.** The same loss on a pipe-based command runner in one integration test (about 100 short `git` children per run): Linux, 47 lost `close` events in 100 runs; macOS 27.2 arm64, 4 children left unreaped zombies with no `exit` and 3 lost `close` events in 100 runs. Replacing the one awaited `expect(...).rejects` in the reduced test stopped the loss: 0 in 100 runs, against 42 lost in 37 of 100 unchanged.

**macOS.** <fill from 6900 task 4 if it has a result; otherwise:> Bun watches the process with `EV_ONESHOT` on macOS, so a skipped event there should be a lost `exit`, which matches the zombies above; `nested-tick.ts` has not yet been run on macOS.

**Expected.** Every child's `exit`, and EOF on each of its pipes, is delivered, whether or not a callback ran a nested tick. For example, one-shot pipe readers could be level-triggered like the pidfd, or the outer dispatch could keep its own copy of the ready list.

**Versions.** Bun 1.4.4 (our pin). Canary: `<version>`, `<reproduces / does not>`.

**Impact.** Any test that awaits `expect(promise).resolves`/`.rejects` while another child is finishing can hang that child's caller until its own timeout. On macOS the child also stays a zombie.

## Existing-report search

The 4260 search on 2026-11-04 (one query) found no matching report; nothing was searched since. Search terms: `child_process close not emitted`, `EPOLLONESHOT`, `waitForPromise nested`, `expect resolves hang spawn`, `PROCESS_POLL_ONE_SHOT`, `zombie child macOS`, `pipe EOF lost`.

## Before filing

- [ ] Check a canary on a throwaway Bun install, never the toolchain's (`bun upgrade --canary` there), with `nested-tick.ts` in `rejects` and `plain` modes; fill in the canary line. A fixed Bun loses no `close`.
- [ ] Fill the macOS paragraph from 6900 task 4 if it has a result.
- [ ] Do not cite the first replays that lost nothing: they did not rebuild the test's repository and are void (6900, "Task 2: the first replays were not the recorded workload").
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed** and set **Status** to `filed`. 4260 is retired: record the canary version, its result and the URL in the Related section of [6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md).
