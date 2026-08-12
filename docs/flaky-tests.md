# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

This file is the only flake registry. An earlier `docs/flake-tests.md` recorded
the same incidents in a second format; its entries were merged here on
2026-08-07 and that file was removed, so a recurrence is compared against one
history rather than two partial ones.

## `App Docker availability > polls every 60 seconds and disables then re-enables container functionality` (`apps/web/src/App.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-11
- **Original command:** `bun test --cwd apps/web --parallel`
- **Worker configuration:** Bun reported `18x PARALLEL` across the web package.
- **Failure:** The test timed out waiting for the second simulated poll to render the recovered `data-container-running="true"` state (duration: 1,019.40 ms).
- **Suite counts:** 5,468 total, 5,466 passed, 1 skipped, 1 failed across 221 files with 18,404 assertions.
- **Isolated rerun:** `bun test --cwd apps/web ./src/App.test.tsx --parallel` -> 55 passed, 0 failed; the target passed in that run. A pre-fix exact-test stress run then reproduced the race 6 times in 20 repetitions and preserved the failing assertion.
- **Root cause:** The test invoked an asynchronous interval callback inside synchronous `act()`. It could observe the third mocked Docker probe while React's resulting availability update had not committed, leaving the terminal projection at `false` until the one-second wait expired. The test also fired a poll before explicitly letting the prior check clear the production in-flight deduplication guard.
- **Fix:** Capture every matching 60-second callback, let the startup check settle, and execute each simulated poll in asynchronous `act()` through the following macrotask before asserting the rendered capability state.
- **Verification:** `bun test --cwd apps/web ./src/App.test.tsx --test-name-pattern "polls every 60 seconds and disables then re-enables container functionality" --rerun-each 20` -> 20 passed, 0 failed; individual runs completed in 9.45-27.46 ms. `bun test --cwd apps/web --parallel` then passed 5,467 tests with 1 skipped and 0 failed across 221 files in 16.98 seconds.

## `standalone backend service > can own a Tailscale Serve listener and publish its HTTPS URL` (`apps/backend/tests/standalone.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout (reported duration 5,000.60 ms); Bun also reported an unhandled `Backend exited during startup:` error with empty stderr from `startBackend` and killed three dangling processes
- **Suite counts:** Backend package: 1,519 tests, 1,518 passed, 1 failed, plus 1 between-test error
- **Isolated rerun:** `bun test ./tests/standalone.test.ts` from `apps/backend` -> 8 passed, 0 failed; the target passed in 2,159.94 ms
- **Root cause:** The test performs two complete standalone-backend startups and two graceful shutdowns but inherited Bun's five-second test budget. Each lifecycle is healthy but takes roughly two to three seconds, so aggregate contention could exhaust the outer budget even though `startBackend` deliberately allows ten seconds for either individual startup.
- **Fix:** Give this two-lifecycle integration test a 20-second budget. The startup helper's own ten-second deadline and every functional assertion remain unchanged, so a hung child still fails with the narrower diagnostic.
- **Verification:** After building the standalone backend, `bun test tests/standalone.test.ts --test-name-pattern 'can own a Tailscale Serve listener' --rerun-each 10` from `apps/backend` -> 10 passed, 0 failed; individual runs completed in 2,037.57-2,896.36 ms.

## `NativeAgentService > rotates fairly beyond the global live-session adoption cap` (`apps/backend/src/core/native-agent-service.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout in two aggregate runs (5,000.03 ms and 5,001.32 ms)
- **Suite counts:** Latest backend package run: 1,519 total, 1,518 passed, 1 failed
- **Isolated rerun:** `bun test src/core/native-agent-service.test.ts` from `apps/backend` -> 161 passed, 0 failed; the target passed in 3,111.70 ms (and 2,400.31 ms after the first observation)
- **Root cause:** The fixture created 1,025 durable native sessions by calling `adoptNativeAgentSession` serially. Each call read and rewrote the growing `native-agent-sessions.json` file, so aggregate I/O contention could push setup beyond Bun's timeout even though the rotation assertions themselves were fast.
- **Fix:** Reuse a bulk fixture helper that writes the same valid 1,025-session snapshot once. This preserves the global 1,024-session cap and second-pass fairness assertions without exercising unrelated quadratic persistence setup.
- **Verification:** `bun test src/core/native-agent-service.test.ts --test-name-pattern "rotates fairly beyond the global live-session adoption cap" --rerun-each 20` from `apps/backend` -> 20 passed, 0 failed; individual runs completed in 36.37-44.93 ms. The complete owning file passed 161 tests, and the final `bun run test` aggregate passed every workspace, root, bridge, protocol-lockfile, and iOS group.

## `NativeAgentService > bounds observations and isolates synchronous and asynchronous telemetry failures` (`apps/backend/src/core/native-agent-service.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout during the aggregate run
- **Suite counts:** Backend package: 1,514 total, 1,512 passed, 2 failed; the other failure was the deterministic `addressPrompt` assertion corrected in the same change
- **Isolated rerun:** `bun test --cwd apps/backend src/core/native-agent-service.test.ts` -> 161 passed, 0 failed; the target passed in 827.81 ms
- **Root cause:** The test created 520 durable native sessions by calling `adoptNativeAgentSession` serially. Each call read and rewrote the growing `native-agent-sessions.json` file, so aggregate I/O contention could push fixture setup beyond Bun's five-second timeout even though the service assertions themselves were fast.
- **Fix:** Seed the same 520 valid persisted session records in one temporary-file write. This preserves coverage of the 512-request and 64-observation production bounds while removing unrelated quadratic fixture I/O.
- **Verification:** `bun test --cwd apps/backend src/core/native-agent-service.test.ts --test-name-pattern 'bounds observations and isolates synchronous and asynchronous telemetry failures' --rerun-each 20` -> 20 passed, 0 failed; individual runs completed in 24.89-42.60 ms.

## `ActionBar toolbar interactions > opens global, Docker, repository, and environment settings` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (workspace web group: `bun test src --parallel=2`)
- **Worker configuration:** Bun reported `2x PARALLEL` for the web package while the root, bridge, and protocol groups ran concurrently
- **Failure:** The test failed in the aggregate web suite after 1440.56ms; the precise matcher text was not retained because the group's buffered output was dominated by a separate 173 MB DOM assertion dump
- **Suite counts:** 5,328 total, 5,325 passed, 2 failed, 1 skipped
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx` -> 143 passed, 0 failed in 12.86s; the affected test passed in 957.68ms
- **Hypothesis:** The failure is load-sensitive: this test performs four asynchronous dialog lookups with Testing Library's one-second default wait, failed after roughly that boundary while all aggregate groups were active, and passed just below the boundary without competing suites. The exact lookup that timed out was not preserved, so no narrower cause is claimed yet.
- **Root cause:** The test serially resolves three React-lazy settings dialogs and waits for two asynchronous callbacks using Testing Library's one-second default. Under the concurrent workspace run, runner contention exhausted that per-operation budget even though the same assertions completed just below it in isolation.
- **Fix:** This working change gives the asynchronous dialog and callback assertions an explicit ten-second wait budget, plus a matching outer test timeout, without removing or weakening any product assertion.
- **Verification:** The exact test passed 20/20 times across four concurrent Bun processes with `seq 1 20 | xargs -P 4 -I% bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --test-name-pattern 'opens global, Docker, repository, and environment settings'`. The complete owning file then passed 143/143 with `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --parallel`.

## `ActionBar workflow tabs > allows ordinary review clicks after long-press suppression expires` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-10
- **Original command:** `bun run test` (workspace web group: `bun test src --parallel=2`); reproduced with `TURBO_FORCE=true ORKESTRATOR_TEST_WORKERS=2 turbo run test:workspace --cwd . --filter=@orkestrator/web --filter=@orkestrator/backend --filter=@orkestrator/web-public --filter=@orkestrator/protocol --concurrency=2 --cache-dir .turbo`
- **Worker configuration:** Two Bun workers per workspace package with Turbo workspace concurrency 2; the original run also overlapped the root, bridge, and protocol-lockfile groups.
- **Failure:** The synchronous dialog lookup failed after the test's 575 ms sleep because the 550 ms long-press callback had not committed its React update yet; failed duration 597.82 ms in the reproduced workspace run.
- **Suite counts:** Web package: 5,448 total, 5,446 passed, 1 skipped, 1 failed with 18,311 assertions.
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx` -> 147 passed, 0 failed with 542 assertions in 12.24 s; the target passed in 1,617.34 ms.
- **Root cause:** The test assumed that sleeping 25 ms past the long-press timer guaranteed both the timer callback and its React state update had completed. Under aggregate scheduling load, the sleep resolved before the dialog update was observable.
- **Fix:** Retain the real long-press gesture and timing, then use a bounded Testing Library wait for the dialog before measuring the one-second click-suppression window.
- **Verification:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --test-name-pattern 'allows ordinary review clicks after long-press suppression expires' --rerun-each 20` -> 20 passed, 0 failed; the exact test completed in 1,613.89-1,660.81 ms. The final `bun run test` aggregate on 2026-08-10 passed every workspace, root, bridge, protocol-lockfile, and iOS group.

## `startWorktreeWatcher > observes a real file write` (`tests/unit/backend/worktree-watcher.test.ts:237`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,686 passed, 1 skipped, 1 failed
- **Failure:** `expect(changes).toBeGreaterThan(0)` received `0` after one file write and a fixed 280 ms total wait; failed duration 281.50 ms
- **Isolated rerun:** `bun test tests/unit/backend/worktree-watcher.test.ts` -> 24 passed, 0 failed; the target passed in 284.11 ms
- **Root cause:** The test drives the real recursive `fs.watch` implementation. The first failure looked like aggregate scheduler contention, but a stress version that waited up to two seconds for one write still missed one event in 30 repetitions. A single OS watcher event is therefore not a reliable synchronization primitive for this test.
- **Fix:** The test now performs bounded, distinct file writes until the watcher reports a change or a two-second deadline expires. A broken watcher still fails at the deadline, while one dropped OS event no longer fails the suite.
- **Verification:** `bun test tests/unit/backend/worktree-watcher.test.ts --test-name-pattern "observes a real file write" --rerun-each 50` -> 50 passed, 0 failed. Targeted stress and the final aggregate suite both passed.

## `at-most-once dispatch > a delayed retry rebinds to the replacement engine generation` (`bridges/codex-bridge/src/app-server-runtime.test.ts:3228`)

- **Status:** resolved
- **Date observed:** 2026-08-05, recurred 2026-08-06
- **Original command:** `bun test bridges --parallel` (aggregate bridge group: `bun test bridges --parallel=2`)
- **Suite counts:** 2,215 passed, 11 skipped, 1 failed
- **Failure:** the final transcript roles were expected to be `["user", "assistant"]` but were `[]`; failed duration 91.73 ms
- **Isolated rerun:** 260 passed, 0 failed with the target at 94.82 ms on the first attempt, but a later isolated run reproduced the failure directly (259 passed, 1 failed, the same assertion in 152.06 ms). This proved the flake was not merely cross-file contention.
- **Reproduction:** the exact test failed 8 of 20 runs before the fix.
- **Root cause:** The bridge appended an optimistic user/assistant exchange before dispatch. On the explicit `-32001` overload path `prompt()` awaited `journal.markRetryable()` and only then captured `context.messages`. A child restart during that await could detach the unmaterialized context, and detachment replaces `context.messages` with an empty array, so the replacement generation received an empty transcript even though the turn itself started once.
- **Fix:** Capture the optimistic message array before the first retry-path await, then wait again for generation recovery after the readiness-triggering re-attach and merge the retained messages into whichever replacement context became canonical. The regression test now gates the journal write and restarts the engine while it is stalled, deterministically exercising the generation race.
- **Verification:** `bun test bridges/codex-bridge/src/app-server-runtime.test.ts --test-name-pattern "a delayed retry rebinds to the replacement engine generation" --rerun-each 30` -> 30/30 passed; the complete runtime file passed 260 tests with 828 assertions.

## `InitializationLogs > shows an initial failure and recovers on a later poll` (`apps/web/src/components/terminal/InitializationLogs.test.tsx:53`)

- **Status:** resolved
- **Date observed:** 2026-08-05, recurred 2026-08-06
- **Original command:** `bun run test` (workspace web group)
- **Suite counts:** 5,336 passed, 1 skipped, 1 failed across 216 files
- **Failure:** `TestingLibraryElementError: Unable to find an element with the text: container ready.` The component still showed `Waiting for container output...` at the one-second timeout; failed duration 1,023.55 ms
- **Isolated rerun:** `bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx` -> 7 passed, 0 failed; the target passed in 9.10 ms, and 33.76 ms when run by exact name
- **First root cause (2026-08-05):** the mock returned `"container ready"` for only one 5 ms polling cycle, so its default empty response could replace that transient state before Testing Library observed it. The exact test failed 1 of 20 runs.
- **First fix (2026-08-05):** keep returning `"container ready"` after the initial rejection, and restore the expected console-error spy in a `finally` block. 30 of 30 repeated runs passed afterwards.
- **Second root cause (2026-08-06):** the test still used a real five-millisecond interval and a one-second UI timeout to drive the recovery poll. Under aggregate load that timer was not a deterministic signal that the second mocked request had run and committed its React update.
- **Second fix (2026-08-06):** intercept only the component's five-millisecond interval, capture its poll callback, and invoke that callback inside `act`. Other timers, including Testing Library's own, continue using the real implementation.
- **Verification:** `bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx --test-name-pattern "shows an initial failure and recovers on a later poll" --rerun-each 20` -> 20/20 passed; the owning file passed all 7 tests.

## `keeps a restored session usable when best-effort backend adoption fails` (`apps/web/src/components/codex/CodexChatTab.test.tsx:2230`)

- **Status:** monitoring; never reproduced in the repository's normal aggregate command
- **Date observed:** 2026-08-06 (two separate stress observations)
- **First observation:** `bun test --cwd apps/web src/components/codex/CodexChatTab.test.tsx src/components/terminal/InitializationLogs.test.tsx`, while the full bridge runtime file and a 30-repetition real filesystem watcher stress run were executing at the same time -> 295 passed, 1 failed. The send button remained disabled at the one-second `waitFor` deadline after the mocked best-effort adoption rejection. The exact test then passed 20/20 with `--rerun-each 20`.
- **Second observation:** `bun test src/components/codex/CodexChatTab.test.tsx --parallel`, launched alongside the Claude, OpenCode, and Terminal component test commands, with Bun reporting `18x PARALLEL` for each of four concurrent processes -> 256 total, 255 passed, 1 failed. The test exceeded its one-second UI wait under that load (duration 1004.48 ms).
- **Isolated rerun:** `bun test src/components/codex/CodexChatTab.test.tsx --test-name-pattern 'keeps a restored session usable when best-effort backend adoption fails' --parallel` -> 1 passed, 0 failed in 607 ms; the exact test took 44.62 ms.
- **Hypothesis:** Resource contention is the leading reproduction condition. Both failures landed at the one-second wait boundary under deliberately higher concurrency than the test orchestrator uses. No product or test change has been justified from stress-only observations; the entry is retained so a normal-suite recurrence can be matched to the same readiness assertion.

## OpenCode component timeout cascade (`apps/web/src/components/opencode/OpenCodeChatTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Tests:** 88 tests failed in one cascading run; the first was `unlocks sending when idle arrives before abort completion`, followed by broad one-second `waitFor` timeouts and empty-DOM query failures across model, SSE, session-action, slash-command, and refresh tests
- **Original command:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel`, launched alongside the Claude, Codex, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The first test timed out after 5000ms (duration: 10298.84ms); most subsequent failures clustered around 1001-1004ms or queried an empty DOM after initialization did not complete
- **Suite counts:** 175 total, 87 passed, 88 failed
- **Isolated rerun:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel` -> 175 passed, 0 failed in 9.29s
- **Root cause:** The first timed-out test synchronized five already-controlled operations through wall-clock `waitFor` polling: subscription setup, abort dispatch, queued SSE delivery, abort completion, and the following send. Under the deliberately oversubscribed run those waits consumed the outer five-second budget. Its still-pending abort and event stream then delayed cleanup and contaminated the remaining long-running file, producing the 88-test cascade rather than 88 independent defects.
- **Fix:** Flush the bounded React/microtask work at each controlled boundary and assert synchronously afterward. The test still proves that an idle event unlocks send before the abort promise resolves, preserves the stopped-turn marker, and allows the next prompt; it no longer waits for elapsed polling intervals.
- **Verification:** Before the fix, the exact test passed under concurrent load but took 1,502.30-2,685.93 ms across 20 repetitions. After the fix, `bun test src/components/opencode/OpenCodeChatTab.test.tsx --test-name-pattern 'unlocks sending when idle arrives before abort completion' --rerun-each 30` -> 30 passed, 0 failed in 808 ms total; individual runs completed in 13.81-42.95 ms.

## `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after local revert and delete` (`tests/unit/electron/commands.test.ts:6345`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,685 passed, 1 skipped, 10 failed; nine failures were deterministic UI regressions from the reviewed change and this was the only unrelated failure
- **Failure:** `Timed out waiting for changed file to be cached again`; failed duration 3,397.10 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 1 skipped, 0 failed; the target passed in 195.34 ms
- **Root cause:** After rewriting the file, the test immediately requested one refresh and then only waited for its event. That refresh could run before the real filesystem watcher invalidated the shared cache; once it reused the stale empty list, nothing requested another scan and the test could only time out. A single filesystem notification is not a synchronization barrier and may also be coalesced or dropped.
- **Fix:** Keep issuing bounded refreshes while making distinct writes until the production watcher invalidates the cache and the expected one-addition event arrives. The final revert/delete assertions remain unchanged, and a broken invalidation path still fails at the three-second deadline.
- **Verification:** `bun test tests/unit/electron/commands.test.ts --test-name-pattern 'starting a stopped environment resumes backend PR polling|invalidates the shared file-list cache after local revert and delete' --rerun-each 20` -> 40 passed, 0 failed; the cache test completed in 215-238 ms in the retained output.

## `remote gateway > delivers backend events to authenticated event streams` (`tests/unit/electron/gateway.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`); reproduced while isolating that group with `bun test tests --parallel=4`
- **Worker configuration:** Four Bun workers in the root group; the original run also executed workspace, bridge, protocol-lockfile, and iOS groups, and the confirming root-group run overlapped independent bridge and protocol/iOS isolation commands
- **Failure:** The test exceeded Bun's 5,000 ms timeout (duration: 5,000.73 ms)
- **Suite counts:** Root group: 3,749 total, 3,747 passed, 1 skipped, 1 failed across 142 files with 16,070 assertions
- **Isolated rerun:** `bun test tests/unit/electron/gateway.test.ts` -> 174 passed, 0 failed; the target passed in 18.30 ms and the file completed in 6.27 seconds
- **Root cause:** The test emitted its only backend event from an arbitrary ten-millisecond timer started immediately after the HTTP request. Under load, that timer could fire before the server had registered the authenticated event-stream client; events are live incremental updates, so the pre-subscription event was correctly not delivered and the promise waited until Bun's outer timeout.
- **Fix:** Wait until the response has received both the connected frame and a keepalive, then emit exactly once through the live stream. This proves registration and still verifies connected, keepalive, and backend-event delivery without treating elapsed time as readiness.
- **Verification:** The old form passed 30 isolated repetitions but retained the structural pre-subscription race. The fixed test passed 50/50 with `bun test tests/unit/electron/gateway.test.ts --test-name-pattern 'delivers backend events to authenticated event streams' --rerun-each 50`; individual runs completed in 9.07-25.18 ms.

## `Electron backend command registry > starting a stopped environment resumes backend PR polling` (`tests/unit/electron/commands.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Failure:** `expect(received).toContain(expected)` on the resumed polling assertion; failed duration 472.36 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 0 failed, twice consecutively; the target also passed when run alone with `-t`
- **Root cause:** The assertion waited only for the fake `gh` log file to exist. Starting the environment can create that file with an earlier `pr list` discovery call, so the wait could return before the explicitly requested `pr view` check had appended its command; the immediate content assertion then raced the monitor.
- **Fix:** Wait for the exact `pr view <url> --json url,state,mergeable` line that the test is intended to prove rather than using file existence as a proxy.
- **Verification:** The resumed-poll test and the diff-cache test shared a 20-repetition owning-file stress command: 40 passed, 0 failed in 9.73 seconds. The resumed-poll case completed in 122-207 ms in the retained output.

## `an ended agent turn discovers a pull request the agent created itself` (`apps/backend/src/core/pr-monitor-agent-completion.integration.test.ts:203`)

- **Status:** resolved
- **Date observed:** 2026-08-06; recurred and reproduced 2026-08-07; recurred 2026-08-08; recurred 2026-08-10; recurred on 4 of 4 aggregate runs 2026-08-11
- **Original command:** `bun run test` (workspace backend group, `bun test src tests --parallel=2`); reproduction used the same command with two Bun workers per workspace package and Turbo workspace concurrency 2 alongside the root and bridge groups
- **Suite counts:** First observation: 1,409 backend tests, 1 failed; 2026-08-07 recurrences: three runs with 1,498 total, 1,497 passed and 1 failed, and one run with 1,498 total, 1,496 passed and 2 failed, while the root, bridge, and protocol groups ran concurrently
- **Failure:** `expect(received).not.toHaveLength(expected)` because no `PR_MONITOR_CHANGED_EVENT` had been announced; recorded failed durations include 380.34 ms, 371.41 ms, 379.76 ms, 298.54 ms, 226.30 ms, and 197.55–292.83 ms during the reproduction study
- **Isolated rerun:** `bun test --cwd apps/backend src/core/pr-monitor-agent-completion.integration.test.ts` -> 3 passed, 0 failed in 803 ms after the first observation; `bun test src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed in 807 ms, 835 ms, 494 ms, and 784 ms after the recurrences (latest target duration: 200.85 ms); `bun test ./src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed, 11 assertions in 783 ms on 2026-08-07; 2026-08-08 isolated rerun `bun test src/core/pr-monitor-agent-completion.integration.test.ts --timeout 60000` from `apps/backend` -> 3 passed, 0 failed, 11 assertions in 484 ms
- **Recurrence (2026-08-08):** `bun test --cwd apps/backend src --parallel --timeout 60000` -> 1,522 passed, 1 failed, 50 files; the sole failure was this test at `pr-monitor-agent-completion.integration.test.ts:203` (`expect(received).not.toHaveLength(expected)`, failed duration 287.57 ms). The build-pipeline retry coverage change in flight was unrelated; the same file passed alone immediately afterwards.
- **Recurrence (2026-08-10):** `bun test src --parallel` from `apps/backend` -> 1,548 passed, 1 failed, 51 files in 9.73 s; the sole failure was this test (`expect(received).not.toHaveLength(expected)`, failed duration 261.32 ms). The structured-review report repair change in flight touches only the build pipeline; `bun test src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` passed 3 tests with 11 assertions in 491 ms immediately afterwards. Consistent with the fast-run clustering noted below.
- **Recurrence (2026-08-10), aggregate runs at `a0305e4c` — 2 failed, 1 passed:** `bun run test` failed this test twice and then passed the entire suite on a third run, on an unmodified tree both times. Failing runs: workspace group 27.6 s, backend `1,556 passed / 1 failed / 5,869 assertions` across 52 files (failed duration 370.38 ms), and a second run with the same sole failure at 309.77 ms; `Failing groups: workspace (web, backend, web-public, protocol)`. Isolated rerun `bun test src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed, 11 assertions in 483 ms, twice. The passing run took 135.6 s overall with the workspace group's web suite alone at 88.2 s, and every group including iOS was green.
- **Recurrence (2026-08-10), repair-prompt fix head `8df55f80`:** `bun run test` failed with this as the backend workspace's sole failure: 1,563 passed, 1 failed, 5,936 assertions across 52 files in 25.61 s; the aggregate exited 1 after about 81 s, and iOS did not run. The assertion at line 203 again received no `PR_MONITOR_CHANGED_EVENT`. Immediate isolated rerun `bun test --cwd apps/backend src/core/pr-monitor-agent-completion.integration.test.ts` -> 3 passed, 0 failed, 11 assertions in 535 ms; the target passed in 91.55 ms. The changed production files only bound build-pipeline report-repair prompts, so they do not share the PR-monitor path.
- **Corroborates the wall-clock signal below:** both 2026-08-10 aggregate failures finished the workspace group in ~28 s, and the run that passed took ~5× longer. That matches the 2026-08-07 study exactly (~31 s failing versus 133.8 s passing), so "fails when the workspace group is fast" now holds across two separate sessions and two different machines' load conditions.
- **Recurrence (2026-08-11), 4 of 4 aggregate runs — the most reliable reproduction recorded so far:** `bun run test` failed this test at `pr-monitor-agent-completion.integration.test.ts:203` on four consecutive aggregate runs (failed durations 358.56 ms, 232.33 ms, 243.46 ms and 213.64 ms), always with `expect(received).not.toHaveLength(expected)`. The fourth run used `TURBO_FORCE=true`, so no run was a cache hit. Backend counts on the first run: 1,556 total, 1,555 passed, 1 failed, 5,859 assertions across 52 files; the root (3,769 passed, 1 skipped), bridge (2,261 passed, 11 skipped) and protocol-lockfile groups all passed concurrently. Because the workspace group failed, the iOS group never ran on any of the four.
  - **Isolation:** `bun test src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed, 11 assertions in 514 ms. The whole backend group also passed on its own: `bun test --parallel` from `apps/backend` -> 1,556 passed, 0 failed in 11.98 s. Root group alone: 3,787 passed, 0 failed. Web workspace alone: 5,450 passed, 0 failed.
  - **Attribution:** the Claude-credential and entrypoint-allowlist work in flight touches neither the PR monitor nor its polling, and the first of the four failures predates those edits on a clean tree at `b1674ee7`, so that change is ruled out as the cause.
  - **Reinforces the wall-clock signal below:** all four failing runs finished the workspace group in 27–28 s, squarely in the fast band that correlates with failure rather than the 133.8 s band that passed.
- **Recurrence (2026-08-12), backend group run directly at `bfaea86c`:** `bun test src tests --parallel` from `apps/backend` on a clean tree -> 1,565 passed, 1 failed, 5,949 assertions across 52 files in 14.11 s; the sole failure was this test at line 203 with the usual `expect(received).not.toHaveLength(expected)` (failed duration 384.56 ms). Notable because the group was **not** run through Turbo alongside the other groups this time, which weakens the "only under aggregate contention" reading — the 14.11 s group duration is well inside the fast band the entry already correlates with failure. Isolated rerun `bun test src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed. The Docker-availability work in flight touches the renderer, the build-pipeline service and `create_environment`, none of which is on the PR-monitor announcement path.
- **Note for the next investigator:** a failure here aborts the Turbo workspace group, so the `@orkestrator/web` and `@orkestrator/web-public` suites never execute and `scripts/test-all.ts` returns before the iOS group. A red run therefore leaves three suites unverified; run them directly (`bun run --cwd apps/web test:workspace`) rather than assuming the aggregate covered them.
- **Reproduction attempt (2026-08-07), 5 aggregate runs — 4 failed, 1 passed:** `bun run test` (and `TURBO_FORCE=true bun run test`) failed this test on 4 consecutive runs, then passed on a 5th. Two of the four failures were on a clean tree at `bf5874a5` and two with an unrelated working-tree change applied, so the change under review was ruled out as the cause. The backend group run on its own passed 6/6 (`bun test --cwd apps/backend --parallel`, 1,502 tests clean and 1,509 with the change), and the file alone passed in 464 ms.
- **Strongest signal so far — wall-clock, not the flag:** every failing aggregate run finished its workspace group in ~31 s; the one passing aggregate run took 133.8 s for the same group. The failures cluster in fast runs, which is the opposite of a straightforward "slow under load" story and suggests the PR-monitor announcement is racing something that completes sooner when the machine is less contended, rather than missing a window when it is more contended.
- **Caution for the next investigator:** a `bun run test` that reports the workspace group green in ~200 ms is a Turbo cache hit and never executed this test. Use `TURBO_FORCE=true` (or touch a backend file) before treating a pass as evidence.
- **Root cause:** `PrMonitorService.applyDetection` first awaits durable environment persistence, then completes later asynchronous reconciliation, and only emits the completed-check event from `performCheck`'s `finally`. The test waited for `storage.getEnvironment(...).prUrl` and immediately inspected the event array, so it could observe the intentional persistence-before-emission interval. The timing profile looked inverted because faster storage made that interval easier for the polling assertion to hit. A focused pre-fix run reproduced the exact failure 3 times in 30 repetitions, including at 90.41 ms and 91.55 ms.
- **Fix:** Make the bounded wait require both authoritative persistence and the `PR_MONITOR_CHANGED_EVENT` before asserting the persisted fields and event payload. This preserves the product contract that clients are notified; it merely stops using an earlier durability milestone as proof that the later announcement has completed.
- **Verification:** `bun test src/core/pr-monitor-agent-completion.integration.test.ts --test-name-pattern 'an ended agent turn discovers' --rerun-each 50` from `apps/backend` -> 50 passed, 0 failed with 200 assertions in 9.05 seconds. The final backend parallel and repository aggregate runs are recorded below.

## `bridge readiness command > keeps retryable local startup races inside the durable wait` (`apps/backend/src/core/commands-state-sync.test.ts:289`)

- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group, `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the root, bridge, and protocol groups ran concurrently
- **Suite counts:** 1,498 backend tests, 1,496 passed, 2 failed; the other failure was the independently tracked PR-monitor flake above
- **Failure:** Expected the caller-deadline timeout with `retryAfterMs: 1000`, but received the environment-startup-deadline timeout with `retryAfterMs: 500`; failed duration 1001.78 ms
- **Isolated rerun:** `bun test src/core/commands-state-sync.test.ts` from `apps/backend` -> 93 passed, 0 failed with 432 assertions in 8.40 s; the target passed in 1006.90 ms
- **Root cause:** The shared readiness probe and its longest-lived caller expire at the same absolute deadline. Both paths returned public `timed-out` results, but with different messages and retry delays. If aggregate scheduling let the shared probe's retry continuation settle first, its internal environment-startup timeout escaped instead of the caller-deadline contract.
- **Fix:** Normalize a shared-probe timeout at the per-caller boundary. Regardless of whether the shared retry continuation or the caller timer wins at the deadline, `await_bridge_ready` now returns the caller-specific timeout with `retryAfterMs: 1000`; ready and terminal failure results remain unchanged.
- **Verification:** The clock-controlled regression, which deterministically makes the shared timeout settle first, passed 100/100 with `bun test src/core/commands-state-sync.test.ts --test-name-pattern "keeps retryable local startup races inside the durable wait" --rerun-each 100` from `apps/backend`. The owning file passed 93 tests with 432 assertions under `--parallel`; backend typechecking passed; and the final `bun run test` aggregate passed every workspace, root, bridge, protocol-lockfile, and iOS group (40 iOS tests).

## Initial prompt attachment symlink rejection diagnostics (`apps/backend/src/core/commands-state-sync.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-08; recurred 2026-08-10
- **Tests:** `initial prompt attachment command > does not prune through a staging-directory replacement race` and `initial prompt attachment command > rejects symlink ancestors without modifying their external target`
- **Original command:** `bun run test` (workspace backend group, `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Suite counts:** First observation: 1,519 backend tests, 1,518 passed and 1 failed. 2026-08-10 reproduction: 1,556 total, 1,555 passed and 1 failed with 5,858 assertions.
- **Failure:** Expected an error containing `symlink or non-directory ancestor`, but received `Confined file write failed (exit 73)`; the 2026-08-10 recurrence failed the static ancestor test in 29.26 ms.
- **Isolated rerun:** `bun test src/core/commands-state-sync.test.ts` from `apps/backend` -> 93 passed, 0 failed with 432 assertions in 8.52 s after the first observation. On 2026-08-10, `bun test --cwd apps/backend src/core/commands-state-sync.test.ts` -> 94 passed, 0 failed with 436 assertions in 7.10 s; the recurrent target passed in 27.19 ms.
- **Root cause:** `writeFromPinnedRoot` settled its child process on `exit`, which may fire before the final stderr `data` event. The confined helper correctly denied the symlink with exit code 73, but aggregate scheduling sometimes let the parent format the error before it had received the helper's `symlink or non-directory ancestor` diagnostic.
- **Fix:** Settle the confined writer on the child process `close` event, which occurs after its stdio streams close, preserving the fail-closed diagnostic without weakening the external-target assertions.
- **Verification:** `bun test --cwd apps/backend src/core/commands-state-sync.test.ts --test-name-pattern 'rejects symlink ancestors|does not prune through' --rerun-each 30` -> 90 passed, 0 failed; `bun test --cwd apps/backend src/core/path-safety.test.ts --test-name-pattern 'rejects a symlinked ancestor' --rerun-each 30` -> 30 passed, 0 failed. The final `bun run test` aggregate on 2026-08-10 passed every workspace, root, bridge, protocol-lockfile, and iOS group.

## `container runtime environment wiring > Codex configuration copy helpers reject destination root, parent, and file symlinks` (`tests/unit/runtime-env-wiring.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-05
- **Original command:** `bun test tests --parallel`
- **Failure:** `expect(received).toEndWith(expected)` for one of three shell invocations that all printed the same `continued` marker
- **Reproduction:** the exact test passed 40 of 40 isolated repetitions, so the precise environmental trigger was not reproduced
- **Root cause:** not conclusively established. The assertion was unnecessarily coupled to the marker being the final stdout bytes and did not identify whether the destination root, parent, or leaf symlink case failed.
- **Fix:** each invocation now prints a distinct `root-continued`, `parent-continued`, or `leaf-continued` marker and asserts that stdout contains it. This preserves the safety assertion — control returns after the unsafe copy is refused — while making any recurrence diagnostic.
- **Verification:** 50 of 50 repeated runs passed; the complete file passed 31 tests with 235 assertions.

## `ClaudeTmuxChatTab > restores a prompt when the backend re-observes it after key submission` (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun test tests --parallel=4`
- **Failure:** the test exceeded Bun's 5-second timeout
- **Reproduction:** 20 isolated repetitions passed, but each took approximately 3.5 to 4.3 seconds before the fix, leaving too little margin under parallel suite load
- **Root cause:** the test delivered the observation through an optional subscription handler without first proving that the subscription existed, then relied on a broad asynchronous DOM search to detect the result. That wait dominated the test and could outlive the test timeout under load.
- **Fix:** wait for the subscription explicitly, build the repeated observation before dispatch, require the handler to exist, dispatch synchronously inside `act`, and assert both the authoritative store snapshot and rendered prompt.
- **Verification:** 20 of 20 repetitions passed in approximately 22 to 92 ms; the complete component file passed 169 tests with 639 assertions.

## `ClaudeTmuxChatTab > sends each digit for multi-digit numbered confirmation options` (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun test tests --parallel=4`
- **Failure:** the expected `answerSelectionPrompt` call was not observed; React also reported updates outside `act` after the preceding prompt-restoration test timed out
- **Reproduction:** the exact test passed 20 of 20 isolated repetitions
- **Root cause:** no independent failure was reproduced. The failure occurred directly after the timed-out prompt-restoration test, whose unfinished work crossed the test boundary and contaminated the shared component mocks.
- **Fix:** the preceding test now completes deterministically and within tens of milliseconds. The multi-digit test remains independently covered and passes without changing its product assertion.
- **Verification:** the exact test passed 20 of 20 repetitions, the complete component file passed, and the root suite passed with zero failures.

## Environmental, not flaky: `tests/unit/electron/*` on a host without `tmux`

- **Status:** environmental; not a product or test defect
- **Date observed:** 2026-08-07
- **Observation:** on a macOS host with no usable `tmux` binary, the root group takes roughly 1,035 s instead of its normal runtime and reports a handful of timeouts whose wall time is 900 s or more. Which tests fail varies between runs: `live session read paths > does not drop a back-to-back turn while the prior notification is pending`, `Electron backend command registry > backend-owned diff statistics > clears published counts when a repository config retarget cannot be scanned`, and `remote gateway > serializes invoke results once and keeps command metrics private and bounded` in one run; three different `tmux-backend`/`commands` tests in another.
- **Evidence:** the preceding output shows `spawn ... ENOENT` from `apps/backend/src/core/tmux.ts:331`. The affected files pass in isolation (`bun test tests/unit/electron/{tmux-backend,commands,backend-process,commands-io-coverage}.test.ts --parallel` -> 564 passed, 1 skipped, 0 failed in 66.95 s), and a fresh `origin/main` worktree reproduces the same shape, so this is not attributable to any working change.
- **Guidance:** do not record a new flake entry for these unless they fail on a host where `tmux` is installed and the root group runs in its normal time.

## Final validation

The `bun run test` verification runs recorded for the fixes above:

- 2026-08-12 (after resolving every entry that was still open) used
  `TURBO_FORCE=true bun run test` so Turbo could not satisfy any group from
  cache. The workspace group passed in 137.0 seconds, and the root, bridge,
  protocol-lockfile, and iOS groups also passed; iOS executed 40 tests with 0
  failures. The affected web and backend package typechecks passed separately.
- 2026-08-06 (after the `startWorktreeWatcher`, `at-most-once dispatch`, and second `InitializationLogs` fixes) exited 0:
  - workspace: passed in 168.6 seconds — web 5,337 passed / 1 skipped / 0 failed; backend 1,341 passed / 0 failed; web-public 26 passed / 0 failed; protocol 442 passed / 0 failed
  - root: 3,687 passed, 1 skipped, 0 failed across 142 files
  - bridges: 2,216 passed, 11 skipped, 0 failed across 64 files
  - Codex protocol lockfile: passed
  - iOS: 40 passed, 0 failed
  - None of the normal-suite flakes recurred, and the stress-only Codex readiness observation also did not recur in the normal web aggregate.
- The same run confirmed `bun run build:all` completed all 7 package builds, and web, desktop, backend, and Codex bridge typechecking all succeeded.


## Markdown editor follow-up on 2026-08-06

### `TiptapMarkdownEditor` rendered-edit synchronization

- Test file: `apps/web/src/components/markdown/TiptapMarkdownEditor.test.tsx`
- Initial aggregate command: `bun run test` (web workspace group:
  `bun test src --parallel=2`)
- Initial aggregate result: 5,256 passed, 1 skipped, 96 failed; most failures
  were unrelated UI timeouts during the same load-triggered cascade
- Initial target failure: `inserts a separator when adding the first body to
  EOF frontmatter` did not observe its second debounced `onChange` within the
  Testing Library deadline (1,600.74 ms), although the failure DOM already
  contained `Second body`
- Recurrent reduced-worker command: the repository test runner invoked through
  `runAllTests({ cores: 4 })`, which ran the web suite with one Bun worker
- Recurrent target failure: `debounces rich-editor changes into Markdown` did
  not observe the 300 ms callback within a 2,000 ms Testing Library deadline
  (2,105.63 ms)
- Isolated command before the fix: `bun test src --parallel=2` from `apps/web`
- Isolated result before the fix: 5,352 passed, 1 skipped, 0 failed across 217
  files in 82.02 seconds

The production debounce was correctly scheduled, but these tests used elapsed
wall time as their synchronization signal. Under the aggregate runner, unrelated
process and UI-test load could delay both the 300 ms production timer and the
Testing Library polling timer past the assertion deadline.

Fix: serialization-only cases now call the editor's explicit
`flushPendingChanges()` boundary. Debounce-specific cases intercept only the
300 ms store-sync timeout, assert that no early write occurs, run the captured
callback explicitly, and verify that repeated updates leave only the latest
callback scheduled.

Verification:

```sh
bun test src/components/markdown/tiptap-extensions.test.ts \
  src/components/markdown/TiptapMarkdownEditor.test.tsx \
  src/components/markdown/MarkdownEditorTab.test.tsx --parallel
```

Result: 51 passed, 0 failed in 0.98 seconds. Web typechecking and
`git diff --check` also passed.

Status: resolved; the Markdown coverage no longer depends on elapsed wall time.
The aggregate runs also produced failures outside the Markdown scope. Those are
not classified here unless their owning file was rerun independently.

A follow-up full-file stress run exposed the same test-harness pattern in
`preserves EOF TOML frontmatter when saving the first body`: 3 of 280 cases
failed because direct DOM mutation plus one microtask did not always establish
Tiptap's pending state before Ctrl+S. The exact test passed 50/50 alone. All
remaining rich-editor test mutations now use `editor.commands.setContent()`
inside `act`. The stress run also showed that a source-preservation test could
not require the React.lazy fallback after the mock module had already loaded;
that assertion was removed while retaining the raw-source assertion.

Post-fix stress verification:

- `TiptapMarkdownEditor.test.tsx`: 280 passed, 0 failed across 20 runs
- `MarkdownEditorTab.test.tsx`: 260 passed, 0 failed across 20 runs

### `DiffViewerTab` aggregate cascade

- Test file: `apps/web/src/components/terminal/DiffViewerTab.test.tsx`
- Status: resolved
- Original command: `bun test src --parallel=2` from `apps/web`
- Worker configuration: Bun reported `2x PARALLEL`
- Aggregate result: 5,349 passed, 1 skipped, 3 failed across 217 files
- Failures:
  - `DiffViewerTab immutable base cache > bounds retained commit bases to 128
    entries` timed out after 5,000 ms (duration: 5,003.66 ms)
  - `DiffViewerTab editor lifecycle and controls > waits for Monaco
    configuration before mounting the diff editor` expected one Monaco setup
    call but received 39 (duration: 1,015.27 ms)
  - `DiffViewerTab editor lifecycle and controls > keeps the diff editor retry
    usable after a second consecutive failure` expected three Monaco setup calls
    but received five (duration: 8.19 ms); the log also reported a late cache
    assertion from the timed-out test as an unhandled between-test error
- Isolated command: `bun test src/components/terminal/DiffViewerTab.test.tsx
  --parallel`
- Isolated result: 47 passed, 0 failed with 165 assertions in 0.91 seconds
- Hypothesis: the first timeout left cache work and renders alive across test
  boundaries, contaminating later Monaco call counts. The owning file's clean
  rerun proves the aggregate failure is intermittent, but the trigger and a
  deterministic fix have not yet been established.
- Root cause: the cache-cap test mounted, initialized, queried, and unmounted a
  complete React diff viewer 130 times merely to exercise a 128-entry module
  cache. Aggregate scheduling could push that unrelated UI work beyond Bun's
  five-second budget. Once the test timed out, its remaining async renders ran
  across the test boundary and inflated the following Monaco setup call counts.
- Fix: expose a narrow test helper around the same production cache function and
  drive the 130 cache keys directly. Component-level tests still cover cache
  reuse, moving refs, rejection eviction, and key separation; only the capacity
  test avoids redundant editor lifecycles.
- Verification: `bun test src/components/terminal/DiffViewerTab.test.tsx
  --rerun-each 10` -> 470 passed, 0 failed. The capacity case now completes in
  0.13-0.37 ms, and the following Monaco lifecycle tests retained their exact
  call-count assertions across all ten runs.
