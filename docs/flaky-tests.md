# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

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

## `keeps a restored session usable when best-effort backend adoption fails` (`apps/web/src/components/codex/CodexChatTab.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun test src/components/codex/CodexChatTab.test.tsx --parallel`, launched alongside the Claude, OpenCode, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The test exceeded its one-second UI wait while the concurrent component runs were under load (duration: 1004.48ms)
- **Suite counts:** 256 total, 255 passed, 1 failed
- **Isolated rerun:** `bun test src/components/codex/CodexChatTab.test.tsx --test-name-pattern 'keeps a restored session usable when best-effort backend adoption fails' --parallel` -> 1 passed, 0 failed in 607ms
- **Hypothesis:** Resource contention is the leading reproduction condition: the only failure landed at the one-second wait boundary during four concurrent component processes, then the exact test passed in 44.62ms when isolated.

## OpenCode component timeout cascade (`apps/web/src/components/opencode/OpenCodeChatTab.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Tests:** 88 tests failed in one cascading run; the first was `unlocks sending when idle arrives before abort completion`, followed by broad one-second `waitFor` timeouts and empty-DOM query failures across model, SSE, session-action, slash-command, and refresh tests
- **Original command:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel`, launched alongside the Claude, Codex, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The first test timed out after 5000ms (duration: 10298.84ms); most subsequent failures clustered around 1001-1004ms or queried an empty DOM after initialization did not complete
- **Suite counts:** 175 total, 87 passed, 88 failed
- **Isolated rerun:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel` -> 175 passed, 0 failed in 9.29s
- **Hypothesis:** This is a load-triggered timeout cascade rather than 88 independent regressions. The failing run took 97.22s and stalled many asynchronous UI assertions at their one-second boundary, while the same file passed completely in 9.29s without the three competing component processes.

The entries below were observed while reviewing the action-bar change on
2026-08-05/06 and are resolved as of 2026-08-06.

## `InitializationLogs > shows an initial failure and recovers on a later poll`

- **Status:** resolved
- **Date observed:** 2026-08-05
- File: `apps/web/src/components/terminal/InitializationLogs.test.tsx`
- Original suite: `bun run test` (web workspace group)
- Original failure: `TestingLibraryElementError: Unable to find an element
  with the text: container ready.`
- Reproduction: the exact test failed 1 of 20 runs before the fix. The failed
  DOM had already returned to `Waiting for container output...`.
- Cause: the mock returned `"container ready"` for only one 5 ms polling cycle.
  Its default empty response could replace that transient state before
  Testing Library observed it.
- Fix: keep returning `"container ready"` after the initial rejection, and
  restore the expected console-error spy in a `finally` block.
- Post-fix evidence: 30 of 30 repeated runs passed; the complete file passed
  7 tests with 27 assertions.

## `at-most-once dispatch > a delayed retry rebinds to the replacement engine generation`

- **Status:** resolved
- **Date observed:** 2026-08-05
- File: `bridges/codex-bridge/src/app-server-runtime.test.ts`
- Original suite: `bun test bridges --parallel`
- Original failure: the final transcript roles were expected to be
  `["user", "assistant"]` but were `[]`.
- Reproduction: the exact test failed 8 of 20 runs before the fix.
- Cause: after an explicit overload, `prompt()` awaited
  `journal.markRetryable()` before retaining the optimistic messages. A child
  restart during that await could detach the unmaterialized context and clear
  `context.messages`, so the replacement generation received an empty
  transcript.
- Fix: retain the optimistic messages before the first retry-path await. The
  regression test now gates the journal write and restarts the engine while it
  is stalled, deterministically exercising the generation race.
- Post-fix evidence: 30 of 30 repeated race tests passed; the complete runtime
  file passed 260 tests with 828 assertions.

## `container runtime environment wiring > Codex configuration copy helpers reject destination root, parent, and file symlinks`

- **Status:** resolved
- **Date observed:** 2026-08-05
- File: `tests/unit/runtime-env-wiring.test.ts`
- Original suite: `bun test tests --parallel`
- Original failure: `expect(received).toEndWith(expected)` for one of three
  shell invocations that all printed the same `continued` marker.
- Reproduction: the exact test passed 40 of 40 isolated repetitions, so the
  precise environmental trigger was not reproduced.
- Cause: not conclusively established. The assertion was unnecessarily coupled
  to the marker being the final stdout bytes and did not identify whether the
  destination root, parent, or leaf symlink case failed.
- Fix: each invocation now prints a distinct `root-continued`,
  `parent-continued`, or `leaf-continued` marker and asserts that stdout
  contains it. This preserves the safety assertion—control returns after the
  unsafe copy is refused—while making any recurrence diagnostic.
- Post-fix evidence: 50 of 50 repeated runs passed; the complete file passed
  31 tests with 235 assertions.

## `ClaudeTmuxChatTab > restores a prompt when the backend re-observes it after key submission`

- **Status:** resolved
- **Date observed:** 2026-08-06
- File: `tests/unit/components/ClaudeTmuxChatTab.test.tsx`
- Original suite: `bun test tests --parallel=4`
- Original failure: the test exceeded Bun's 5-second timeout.
- Reproduction: 20 isolated repetitions passed, but each took approximately
  3.5 to 4.3 seconds before the fix, leaving too little margin under parallel
  suite load.
- Cause: the test delivered the observation through an optional subscription
  handler without first proving that the subscription existed, then relied on
  a broad asynchronous DOM search to detect the result. That wait dominated
  the test and could outlive the test timeout under load.
- Fix: wait for the subscription explicitly, build the repeated observation
  before dispatch, require the handler to exist, dispatch synchronously inside
  `act`, and assert both the authoritative store snapshot and rendered prompt.
- Post-fix evidence: 20 of 20 repetitions passed in approximately 22 to 92 ms;
  the complete component file passed 169 tests with 639 assertions.

## `ClaudeTmuxChatTab > sends each digit for multi-digit numbered confirmation options`

- **Status:** resolved
- **Date observed:** 2026-08-06
- File: `tests/unit/components/ClaudeTmuxChatTab.test.tsx`
- Original suite: `bun test tests --parallel=4`
- Original failure: the expected `answerSelectionPrompt` call was not observed;
  React also reported updates outside `act` after the preceding prompt-restoration
  test timed out.
- Reproduction: the exact test passed 20 of 20 isolated repetitions.
- Cause: no independent failure was reproduced. The failure occurred directly
  after the timed-out prompt-restoration test, whose unfinished work crossed the
  test boundary and contaminated the shared component mocks.
- Fix: the preceding test now completes deterministically and within tens of
  milliseconds. The multi-digit test remains independently covered and passes
  without changing its product assertion.
- Post-fix evidence: the exact test passed 20 of 20 repetitions, the complete
  component file passed, and the root suite passed with zero failures.

## Final validation

- `bun run test` exited 0 after the fixes. The workspace, root, bridge, Codex
  protocol lockfile, and iOS groups all completed successfully.
- Root suite: 3,687 passed, 1 skipped, 0 failed across 142 files.
- Bridge suite: 2,216 passed, 11 skipped, 0 failed across 64 files.
- `bun run build:all` completed all 7 package builds successfully.
- Web, desktop, backend, and Codex bridge typechecking completed successfully.
