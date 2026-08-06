# Flaky tests

This living record tracks tests that fail under normal aggregate or parallel
execution but pass when their owning file is rerun alone. Resolved entries stay
here with their reproduction and verification evidence so a recurrence can be
compared with the original failure mode.

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
