# Bun: a nested event-loop tick loses child-process completion events

**Tracker:** Bun, <https://github.com/oven-sh/bun/issues> (bug report)
**Status:** do not file (2026-11-15): Bun canary 1.4.5-canary.1+ed4363334 loses nothing in any mode, and Bun's open [oven-sh/bun#33261](https://github.com/oven-sh/bun/issues/33261) already tracks this mechanism. Re-run on the 1.4.5 release ([6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md) task 5); if it loses nothing there, this file is deleted; if it still loses events, an agent sets **Status** to `ready to file, as a comment on #33261` and the user posts the issue text below there through the manual-test checklist, never as a new issue.
**Source:** 4260 (retired) task 1, "Draft report" (`git show 53340356c:docs/todo/cross-cutting/4260-bun-loses-child-process-events.md`); [6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md) task 3 (cause), tasks 1, 4 (macOS and canary) and 5 (the 1.4.5 re-run); filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; reproduction [`nested-tick.ts`](../../scripts/lost-child-event/nested-tick.ts) and [`probe.ts`](../../scripts/lost-child-event/probe.ts)
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

**macOS.** The same file on macOS 27.2 arm64 (18 cores, Bun 1.4.4, host load average 18 to 26), 1,000 iterations each, 30 s hold:

| `LOST_CHILD_NESTED_MODE` | Children | Lost `exit` | Lost `close` |
| --- | --- | --- | --- |
| `rejects` | 3,000 | 8 | 1 |
| `resolves` | 3,000 | 11 | 0 |
| `sleep` | 2,000 | 16 | 4 |
| `plain` | 3,000 | 0 | 0 |
| `rejects` with no second child | 2,000 | 0 | 0 |

As Bun watches the process with `EV_ONESHOT` on macOS, the dropped event there is mostly the child's exit: each of the 35 lost `exit` events was a child that became a zombie 0 to 20 ms after spawn, with its process group gone, and was still an unreaped zombie when the probe gave up 30 s after the last iteration. The 5 lost `close` events match Linux: the child had exited, its group was gone, both our output ends polled `IN|HUP`, and the JS streams were flowing and empty with at least one not ended. Every lost child was again the second one. Two more `sleep` runs of 3,000 iterations each lost 31 and 27 of 6,000 children.

**Expected.** Every child's `exit`, and EOF on each of its pipes, is delivered, whether or not a callback ran a nested tick. For example, one-shot pipe readers could be level-triggered like the pidfd, or the outer dispatch could keep its own copy of the ready list.

**Versions.** Bun 1.4.4 (our pin, and the newest release on 2026-11-15). Canary 1.4.5-canary.1+ed4363334 (2026-11-15), macOS arm64: does not reproduce. It lost 0 of 13,000 children across the five modes above, and 0 of 12,000 in two 3,000-iteration `sleep` runs interleaved with 1.4.4 runs that lost 31 and 27 of 6,000. No commit between `bun-v1.4.4` and `ed4363334` names this fix; the event-loop ownership refactors of 2026-11-13 to 2026-11-15 (for example #48866, "event loop: share the loop instead of borrowing it exclusively") are the likely change, but that is not verified.

**Impact.** Any test that awaits `expect(promise).resolves`/`.rejects` while another child is finishing can hang that child's caller until its own timeout. On macOS the child also stays a zombie.

## Existing-report search

Searched 2026-11-15 (`gh search issues` and `gh search prs` in oven-sh/bun, open and closed) for: `child_process close not emitted`, `EPOLLONESHOT`, `waitForPromise`, `expect resolves hang spawn`, `PROCESS_POLL_ONE_SHOT`, `zombie child macOS`, `pipe EOF lost`, `close event never fires spawn`, `child process zombie bun test`.

- **Same mechanism, open:** [#33261](https://github.com/oven-sh/bun/issues/33261), "event loop: never re-enter from inside a dispatch callback (de-block expect().resolves and HTMLRewriter.transform, then assert)" (opened 2026-07-02, last updated 2026-11-13). It names a nested `epoll_wait`/`kevent` overwriting `ready_polls` and losing one-shot subprocess pipe readers and process watchers, with `expect().resolves`/`.rejects` as a trigger, and lists the work to remove those callers. Its fixes so far: [#32233](https://github.com/oven-sh/bun/pull/32233) (dispatcher tolerates re-entry) and [#30595](https://github.com/oven-sh/bun/pull/30595) (`expect` stops blocking) were closed unmerged; [#33267](https://github.com/oven-sh/bun/pull/33267) (a counter for nested ticks) is open. This report adds a standalone `node:child_process` reproduction and the macOS `exit` loss.
- **Probably the same loss, open:** [#41024](https://github.com/oven-sh/bun/issues/41024), "bun test --parallel on macOS: promisified execFile never settles (lost subprocess exit notification)" (2026-08-31, no reproduction; its one comment points at a different cause, [#45483](https://github.com/oven-sh/bun/issues/45483)).
- [#37189](https://github.com/oven-sh/bun/issues/37189) is a deadlock in `await expect(p).rejects` from a Worker continuation, a different symptom.

## Before filing

- [x] Check a canary on a throwaway Bun install, never the toolchain's, with `nested-tick.ts` in `rejects` and `plain` modes; fill in the canary line. Done 2026-11-15: the release asset `bun-darwin-aarch64.zip` of the `canary` tag, checksum matched against its `SHASUMS256.txt`, unpacked under this build's git-ignored `output/` and removed afterwards; all five modes lost nothing (Versions line). So do not file now.
- [x] Fill the macOS paragraph from 6900 task 4 if it has a result. Done 2026-11-15 (6900 task 4).
- [x] Do not cite the first replays that lost nothing: they did not rebuild the test's repository and are void (6900, "Task 2: the first replays were not the recorded workload"). Not cited.
- [x] Search for duplicates. Done 2026-11-15: #33261 tracks the mechanism (above).
- [ ] When Bun 1.4.5 is released, re-run `nested-tick.ts` in `rejects`, `sleep` and `plain` modes on it on macOS and Linux (6900 task 5). If it loses nothing, delete this file and record the result in 6900; if it still loses events, set **Status** to `ready to file, as a comment on #33261` for the user to post (agents never post it).

## After filing

If posted as a comment on #33261, record the comment's URL and date under **Filed** and set **Status** to `filed`. 4260 is retired: record the canary version, its result and the URL in the Related section of [6900](../todo/cross-cutting/6900-reproduce-lost-child-event-on-pipe-capture.md).
