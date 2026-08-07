# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

This file is the only flake registry. An earlier `docs/flake-tests.md` recorded
the same incidents in a second format; its entries were merged here on
2026-08-07 and that file was removed, so a recurrence is compared against one
history rather than two partial ones.

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

- **Status:** open
- **Date observed:** 2026-08-06
- **Tests:** 88 tests failed in one cascading run; the first was `unlocks sending when idle arrives before abort completion`, followed by broad one-second `waitFor` timeouts and empty-DOM query failures across model, SSE, session-action, slash-command, and refresh tests
- **Original command:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel`, launched alongside the Claude, Codex, and Terminal component test commands
- **Worker configuration:** Bun reported `18x PARALLEL` for each of four concurrent test processes
- **Failure:** The first test timed out after 5000ms (duration: 10298.84ms); most subsequent failures clustered around 1001-1004ms or queried an empty DOM after initialization did not complete
- **Suite counts:** 175 total, 87 passed, 88 failed
- **Isolated rerun:** `bun test src/components/opencode/OpenCodeChatTab.test.tsx --parallel` -> 175 passed, 0 failed in 9.29s
- **Hypothesis:** This is a load-triggered timeout cascade rather than 88 independent regressions. The failing run took 97.22s and stalled many asynchronous UI assertions at their one-second boundary, while the same file passed completely in 9.29s without the three competing component processes.

## `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after local revert and delete` (`tests/unit/electron/commands.test.ts:6345`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,685 passed, 1 skipped, 10 failed; nine failures were deterministic UI regressions from the reviewed change and this was the only unrelated failure
- **Failure:** `Timed out waiting for changed file to be cached again`; failed duration 3,397.10 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 1 skipped, 0 failed; the target passed in 195.34 ms
- **Hypothesis:** The aggregate failure exhausted the cache-repopulation deadline while the same behavior completed quickly in isolation. This is consistent with aggregate scheduling or filesystem-watcher latency, but no narrower root cause has been reproduced.

## `Electron backend command registry > starting a stopped environment resumes backend PR polling` (`tests/unit/electron/commands.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Failure:** `expect(received).toContain(expected)` on the resumed polling assertion; failed duration 472.36 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 0 failed, twice consecutively; the target also passed when run alone with `-t`
- **Hypothesis:** A repeat aggregate run did not reproduce this failure and instead failed the agent-completion PR-monitor test below. Both wait for a background poll announcement within the test window, which is consistent with aggregate scheduling latency rather than a demonstrated product defect.

## `an ended agent turn discovers a pull request the agent created itself` (`apps/backend/src/core/pr-monitor-agent-completion.integration.test.ts:203`)

- **Status:** open
- **Date observed:** 2026-08-06; reproduced 2026-08-07
- **Original command:** `bun run test` (workspace backend group); reproduced with the same command using two Bun workers per workspace package and Turbo workspace concurrency 2 alongside the root and bridge groups
- **Suite counts:** 1,409 backend tests, 1 failed; every other group passed
- **Failure:** `expect(received).not.toHaveLength(expected)` because no `PR_MONITOR_CHANGED_EVENT` had been announced; failed duration 380.34 ms originally and 226.30 ms on 2026-08-07
- **Isolated rerun:** `bun test ./src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` -> 3 passed, 0 failed, 11 assertions in 783 ms on 2026-08-07
- **Reproduction attempt (2026-08-07), 5 aggregate runs — 4 failed, 1 passed:** `bun run test` (and `TURBO_FORCE=true bun run test`) failed this test on 4 consecutive runs, then passed on a 5th. Two of the four failures were on a clean tree at `bf5874a5` and two with an unrelated working-tree change applied, so the change under review was ruled out as the cause. Failed durations 197.55–292.83 ms. The backend group run on its own passed 6/6 (`bun test --cwd apps/backend --parallel`, 1,502 tests clean and 1,509 with the change), and the file alone passed in 464 ms.
- **Strongest signal so far — wall-clock, not the flag:** every failing aggregate run finished its workspace group in ~31 s; the one passing aggregate run took 133.8 s for the same group. The failures cluster in fast runs, which is the opposite of a straightforward "slow under load" story and suggests the PR-monitor announcement is racing something that completes sooner when the machine is less contended, rather than missing a window when it is more contended.
- **Caution for the next investigator:** a `bun run test` that reports the workspace group green in ~200 ms is a Turbo cache hit and never executed this test. Use `TURBO_FORCE=true` (or touch a backend file) before treating a pass as evidence.
- **Hypothesis:** Both this and the preceding PR-polling test wait on an announced PR-monitor event. No narrower root cause has been isolated, and the reproduction is not yet reliable enough to bisect against — 4-in-5 under a specific timing profile, not deterministic.

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
