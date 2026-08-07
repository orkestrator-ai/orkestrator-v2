# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

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
- Status: open
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
