# Flaky tests

This document records credible flaky behavior observed in aggregate, parallel,
or deliberate stress runs. An isolated pass does not erase the original
failure. Each entry keeps the failure evidence, root cause when known, fix, and
verification so a recurrence can be compared with prior behavior.

## Observed on 2026-08-06

### `startWorktreeWatcher > observes a real file write`

- Test file: `tests/unit/backend/worktree-watcher.test.ts:237`
- Initial aggregate command: `bun run test` (root group:
  `bun test tests --parallel=4`)
- Initial aggregate result: 3,686 passed, 1 skipped, 1 failed
- Initial failed duration: 281.50 ms
- Initial isolated command: `bun test tests/unit/backend/worktree-watcher.test.ts`
- Initial isolated result: 24 passed, 0 failed; target passed in 284.11 ms
- Failure: `expect(changes).toBeGreaterThan(0)` received `0` after one file
  write and a fixed 280 ms total wait.

The test drives the real recursive `fs.watch` implementation. The first failure
looked like aggregate scheduler contention, but a stress version that waited up
to two seconds for one write still missed one event in 30 repetitions. A single
OS watcher event is therefore not a reliable synchronization primitive for this
test.

Fix: the test now performs bounded, distinct file writes until the watcher
reports a change or a two-second deadline expires. A broken watcher still fails
at the deadline, while one dropped OS event no longer fails the suite.

Verification:

```sh
bun test tests/unit/backend/worktree-watcher.test.ts \
  --test-name-pattern "observes a real file write" --rerun-each 50
```

Result: 50 passed, 0 failed. Full aggregate verification is recorded below.

Status: resolved; targeted stress and the final aggregate suite passed.

### `at-most-once dispatch > a delayed retry rebinds to the replacement engine generation`

- Test file: `bridges/codex-bridge/src/app-server-runtime.test.ts:3228`
- Initial aggregate command: `bun run test` (bridge group:
  `bun test bridges --parallel=2`)
- Initial aggregate result: 2,215 passed, 11 skipped, 1 failed
- Initial failed duration: 91.73 ms
- Initial isolated result: 260 passed, 0 failed; target passed in 94.82 ms
- Recurrent aggregate failure: expected message roles
  `["user", "assistant"]`, received `[]`
- Recurrent isolated result: 259 passed, 1 failed; the same assertion failed in
  152.06 ms, proving this was not merely cross-file contention.

The bridge appended an optimistic user/assistant exchange before dispatch. On
the explicit `-32001` overload path it awaited the retryable journal write and
only then captured `context.messages`. A generation restart could detach the
unmaterialized thread during that write; detachment replaces
`context.messages` with an empty array, so the retry carried an empty transcript
onto the replacement generation even though the turn itself started once.

Fix: capture the optimistic message array before the first journal await, then
wait again for generation recovery after the readiness-triggering re-attach and
merge the retained messages into whichever replacement context became
canonical.

Verification:

```sh
bun test bridges/codex-bridge/src/app-server-runtime.test.ts \
  --test-name-pattern "a delayed retry rebinds to the replacement engine generation" \
  --rerun-each 30
bun test bridges/codex-bridge/src/app-server-runtime.test.ts
```

Result: the target passed 30/30 repetitions; the entire owning file passed.
Full aggregate verification is recorded below.

Status: resolved; targeted stress, the owning file, and the final aggregate
suite passed.

### `InitializationLogs > shows an initial failure and recovers on a later poll`

- Test file: `apps/web/src/components/terminal/InitializationLogs.test.tsx:53`
- Aggregate command: `bun run test` (workspace web group)
- Aggregate result: 5,336 passed, 1 skipped, 1 failed across 216 files
- Failed duration: 1,023.55 ms
- Failure: Testing Library could not find `container ready`; the component still
  showed `Waiting for container output...` at the one-second timeout.
- Isolated command:
  `bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx`
- Isolated result: 7 passed, 0 failed; the target passed in 9.10 ms
- Exact isolated command result: target passed in 33.76 ms

The test used a real five-millisecond interval and a one-second UI timeout to
drive the recovery poll. Under aggregate load the timer was not a deterministic
signal that the second mocked request had run and committed its React update.

Fix: intercept only the component's five-millisecond interval, capture its poll
callback, and invoke that callback inside `act`. Other timers, including Testing
Library's own timers, continue using the real implementation.

Verification:

```sh
bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx \
  --test-name-pattern "shows an initial failure and recovers on a later poll" \
  --rerun-each 20
bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx
```

Result: the target passed 20/20 repetitions and the owning file passed all 7
tests. Full aggregate verification is recorded below.

Status: resolved; targeted stress, the owning file, and the final aggregate
suite passed.

### Stress-only observation: `CodexChatTab > keeps a restored session usable when best-effort backend adoption fails`

- Test file: `apps/web/src/components/codex/CodexChatTab.test.tsx:2230`
- Stress command:
  `bun test --cwd apps/web src/components/codex/CodexChatTab.test.tsx src/components/terminal/InitializationLogs.test.tsx`
- Concurrent load: the full bridge runtime file and a 30-repetition real
  filesystem watcher stress run were executing at the same time.
- Stress result: 295 passed, 1 failed
- Failure: the send button remained disabled at the one-second `waitFor`
  deadline after the mocked best-effort adoption rejection.
- Isolated stress command: the exact test with `--rerun-each 20`
- Isolated stress result: 20 passed, 0 failed

This has not failed in the repository's normal aggregate command and was only
observed under deliberately higher concurrency than the test orchestrator uses.
No product or test change has been justified from this single stress-only
observation. Retain it here so a normal-suite recurrence can be matched to the
same readiness assertion.

Status: monitoring; not reproduced in the normal aggregate suite.

### `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after local revert and delete`

- Test file: `tests/unit/electron/commands.test.ts:6345`
- Aggregate command: `bun run test` (root group:
  `bun test tests --parallel=4`)
- Aggregate result: 3,685 passed, 1 skipped, 10 failed; nine failures were
  deterministic UI regressions from the reviewed change and this was the only
  unrelated failure.
- Failed duration: 3,397.10 ms
- Failure: `Timed out waiting for changed file to be cached again`.
- Isolated command: `bun test tests/unit/electron/commands.test.ts`
- Isolated result: 362 passed, 1 skipped, 0 failed; the target passed in
  195.34 ms.

The aggregate failure exhausted the test's cache-repopulation deadline while
the same behavior completed quickly in isolation. This is consistent with
aggregate scheduling or filesystem-watcher latency, but no narrower root cause
has yet been reproduced.

Status: open; passed in isolation after failing in the normal parallel suite.

### `Electron backend command registry > starting a stopped environment resumes backend PR polling`

- Test file: `tests/unit/electron/commands.test.ts`
- Aggregate command: `bun run test` (root group: `bun test tests --parallel=4`)
- Aggregate result: one failure in the root group; every other group passed.
- Failed duration: 472.36 ms
- Failure: `expect(received).toContain(expected)` on the resumed polling
  assertion.
- Isolated command: `bun test tests/unit/electron/commands.test.ts`
- Isolated result: 362 passed, 0 failed, twice consecutively; the target also
  passed when run alone with `-t`.
- Observed: 2026-08-06.

The same aggregate command run again did not reproduce this failure, and a
different PR-monitor test failed instead (below). Both assert on an event that
a background poll has to deliver within the test's window, which is consistent
with aggregate scheduling latency rather than a defect in either test.

Status: open; passed in isolation and did not recur in a repeat aggregate run.

### `an ended agent turn discovers a pull request the agent created itself`

- Test file: `apps/backend/src/core/pr-monitor-agent-completion.integration.test.ts:203`
- Aggregate command: `bun run test` (workspace group, backend package)
- Aggregate result: backend workspace 1,409 tests, 1 failed; every other group
  passed.
- Failed duration: 380.34 ms
- Failure: `expect(received).not.toHaveLength(expected)` — no
  `PR_MONITOR_CHANGED_EVENT` had been announced when the assertion ran.
- Isolated command:
  `bun test --cwd apps/backend src/core/pr-monitor-agent-completion.integration.test.ts`
- Isolated result: 3 passed, 0 failed, in 803 ms.
- Observed: 2026-08-06.

Failed in the aggregate run immediately after the `commands.test.ts` PR-polling
entry above passed in that same run, and vice versa — the two have not failed
together. Both wait on an announced PR-monitor event, so the shared hypothesis
is that the announcement can miss the assertion's window under aggregate load.
No narrower root cause has been reproduced.

Status: open; passed in isolation after failing in the normal parallel suite.

## Final aggregate verification

The final `bun run test` completed successfully on 2026-08-06:

- workspace: passed in 168.6 seconds
  - web: 5,337 passed, 1 skipped, 0 failed
  - backend: 1,341 passed, 0 failed
  - web-public: 26 passed, 0 failed
  - protocol: 442 passed, 0 failed
- root: 3,687 passed, 1 skipped, 0 failed
- bridges: 2,216 passed, 11 skipped, 0 failed
- Codex protocol lockfile: passed
- iOS: 40 passed, 0 failed

None of the normal-suite flakes above recurred. The stress-only Codex readiness
observation also did not recur in the normal web aggregate.
