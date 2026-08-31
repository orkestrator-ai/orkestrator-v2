# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

This file is the only flake registry. An earlier `docs/flake-tests.md` recorded
the same incidents in a second format; its entries were merged here on
2026-08-07 and that file was removed, so a recurrence is compared against one
history rather than two partial ones.

## `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow, editor, and panel shortcuts` (`apps/web/src/components/layout/ActionBar.test.tsx:5467`)

- **Status:** open — third recorded occurrence of the same assertion, after
  `ActionBar toolbar interactions > runs commands and opens the editor from keyboard shortcuts`
  (`ActionBar.test.tsx:1704`, observed 2026-08-17, resolved in the 2026-08-27
  sweep and already reopened once as "recurred after the 2026-08-27 resolution
  sweep"). The test has since been renamed and moved; the failing assertion is
  the same line of code, so this continues that history rather than starting a
  new one.
- **Date observed:** 2026-08-31
- **Original command:**
  `bun run test:logged -- --name web-package-tests -- bun --cwd=apps/web test --parallel=4 --only-failures`,
  on `model-selector-theme` (working tree: the shared model-picker theme constant
  and its test).
- **Worker configuration:** four Bun workers on the web package alone, not under
  `scripts/test-all.ts`. No `dev:test` profile was running; the same host had
  just completed a passing run of the identical command.
- **Failure:** `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })`
  at `ActionBar.test.tsx:5467`, after 19.93 ms. `createTabMock` had received
  three calls — `("plain")`, `("agent-native")`, and the `("codex", …)` Review
  tab — so the `Cmd+R` run-commands tab was the only expected call missing.
- **Suite counts:** `5612 pass, 1 skip, 1 fail, 17717 expect() calls. Ran 5614
  tests across 247 files. [40.95s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  -> 198 passed, 0 failed, 773 assertions in 14.86 s.
- **Frequency:** 1 failure in 3 consecutive runs of the identical aggregate
  command on the same host — the run immediately before (at the parent commit)
  and the run immediately after (at the same working tree) both passed the whole
  web package.
- **Hypothesis:** The 2026-08-27 fix added a readiness wait for the accessible
  "Run commands" control before dispatching key events, and that wait is still
  present and did pass here — the earlier mechanism (handler not yet
  subscribed) does not explain this failure, because two other shortcuts in the
  same synchronous block *did* reach `createTabMock`. What distinguishes `Cmd+R`
  is that it is the only one of them fed by `readContainerFileMock`, which the
  test primes with `mockResolvedValueOnce({ content: '{"run":["bun test"]}' })`.
  A single-use mock value is consumed by whichever read arrives first, so any
  additional or reordered `readContainerFile` call under load would leave the
  run-commands state populated from the default mock instead. The evidence
  establishes only that this one asynchronously-fed shortcut was missing while
  its synchronous siblings were not; a recurrence should log every
  `readContainerFileMock` invocation with its arguments before changing the
  assertion, and prefer priming a stable `mockResolvedValue` over a `…Once`
  value if more than one read is observed.
- **Unrelated to the change under test:** neither `ActionBar.tsx` nor
  `ActionBar.test.tsx` references `CreateEnvironmentDialog`, `FeatureBuildFields`
  or `modal-theme`, the only modules that branch touched.

## `json file cache > slices > shares a single parse between concurrent cold readers` (`bridges/claude-bridge/src/services/json-file-cache.test.ts:132`)

- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the bridge group used six Bun workers.
- **Failure:** `getJsonFileParseCount()` was expected to be `1` but was `2` after
  the three concurrent readers returned their expected values (duration: 0.49
  ms).
- **Suite counts:** bridge group — 3,192 total, 3,180 passed, 11 skipped, 1
  failed across 120 files in 56.91 s.
- **Isolated rerun:** `bun --cwd=bridges/claude-bridge test
  src/services/json-file-cache.test.ts` -> 12 passed, 0 failed; the target
  passed in 0.32 ms.
- **Hypothesis:** the parse counter and cache are module-global test
  instrumentation, and the failure occurred only while the bridge worker was
  running the aggregate file set. The evidence establishes interference or
  scheduling sensitivity around that shared state, but does not identify which
  other reader or hook caused the second parse. A recurrence should capture the
  file path and fingerprint for each counted parse before changing the
  assertion.

## `CreateEnvironmentFlowDialog.test.tsx` Bun worker crash (`tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root/agent-support group used six Bun workers while the workspace and
  bridge groups were also active.
- **Failure:** Bun 1.4.0 crashed this file's worker with `SIGSEGV` after 17.61 s
  and aborted the remaining sibling files. The runner explicitly identified it
  as a Bun bug rather than a test assertion.
- **Suite counts:** root/agent-support reported 1,954 passed and 88 failed
  across 2,042 tests; the 88 failures include files aborted after the worker
  panic, not 88 independent assertions.
- **Isolated rerun:** `bun test tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`
  passed 33/33 with 116 assertions in 1.55 s before the aggregate run, against
  the same tree.
- **Hypothesis:** the available evidence establishes only an aggregate-only Bun
  runtime crash. The same run also pushed unrelated timing tests into
  multi-minute durations, so a recurrence should retain Bun's crash report and
  process/resource diagnostics before changing this file's tests.

## `TerminalContainer > keeps launch options while a pending native launch is still outstanding` (`apps/web/src/components/terminal/TerminalContainer.view.test.tsx:6643`)

- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the web workspace ran its parallel package suite
  while the root, bridge, build, and protocol work from `scripts/test-all.ts`
  shared the host.
- **Failure:** the case exceeded its 12-second outer budget after the aggregate
  runner reported 384,624.67 ms; a trailing assertion then observed the pending
  launch already cleared.
- **Suite counts:** web workspace reported 5,577 passed, 1 skipped, 3 failed,
  and 1 trailing error across 5,581 tests.
- **Isolated rerun:** `bun test src/components/terminal/TerminalContainer.view.test.tsx`
  from `apps/web` passed 126/126 in 10.19 s; the affected 3.5-second timer case
  passed in 3,505.35 ms.
- **Hypothesis:** the case deliberately waits 3.5 seconds against real timers.
  Its isolated duration matches that wait, while the aggregate reported more
  than six minutes and also timed out unrelated focus and bridge tests. This
  supports runner/host starvation rather than a launch-state regression.

## `TerminalContainer > replaces a completed setup tab that has neither a PTY nor replayable output` (`apps/web/src/components/terminal/TerminalContainer.view.test.tsx:1732`)

- **Status:** open
- **Date observed:** 2026-08-30
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the web workspace used two Bun workers while the root and bridge groups were
  also active.
- **Failure:** after `setupTabIds()` temporarily reached `[]`, the immediately
  following store snapshot still contained the default plain tab with
  `isSetupTab: true` and normalized optional fields, instead of the expected
  plain tab without setup metadata (duration: 3.25 ms).
- **Suite counts:** web workspace — 5,613 total, 5,611 passed, 1 skipped, 1
  failed across 247 files in 65.02 s.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts
  ./src/components/terminal/TerminalContainer.view.test.tsx --only-failures
  --parallel=2` from `apps/web` -> 126 passed, 0 failed in 10.14 s.
- **Hypothesis:** the test waits for a derived setup-tab ID list and then reads
  the full store in a separate assertion. The aggregate-only result shows that
  the full tab metadata can change across that observation boundary; the
  isolated owner consistently completes the replacement. A recurrence should
  trace pane-layout restore and setup-tab retirement writes before changing the
  production behavior or loosening the assertion.

## `at-most-once dispatch > a delayed retry succeeds and settles the phase after the wait` (`bridges/codex-bridge/src/app-server-runtime-prompt.test.ts:469`)

- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the bridge group ran two Bun workers while the
  workspace, root/agent-support, and protocol groups ran concurrently.
- **Failure:** the case hit Bun's 5-second test timeout after the aggregate
  runner reported 652,578.36 ms. Cleanup then removed its temporary dispatch
  journal directory, producing a trailing `ENOENT` assertion error.
- **Suite counts:** bridge group reported 3,179 passed, 11 skipped, 2 failed,
  and 1 trailing error across 3,192 tests.
- **Isolated rerun:** `bun test src/app-server-runtime-prompt.test.ts` from
  `bridges/codex-bridge` passed 75/75 in 2.23 s; the affected delayed-retry case
  passed in 44.13 ms.
- **Hypothesis:** the journal `ENOENT` followed the outer timeout and fixture
  cleanup. The isolated case completed two orders of magnitude inside its
  budget, while the aggregate's reported duration exceeded ten minutes, so the
  evidence points to aggregate runner starvation rather than dispatch logic.

## `ACP bridge > settles the turn before a delayed Cursor replay and enriches only its captured tools` (`bridges/acp-bridge/src/acp-transcript.test.ts:2447`)

- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the bridge group ran two Bun workers while the
  workspace, root/agent-support, and protocol groups ran concurrently.
- **Failure:** the bounded state wait expired after the aggregate runner
  reported 652,814.96 ms. The final snapshot had completed both turns but had
  not yet applied the delayed replay enrichment expected by the predicate.
- **Suite counts:** bridge group reported 3,179 passed, 11 skipped, 2 failed,
  and 1 trailing error across 3,192 tests.
- **Isolated rerun:** `bun test src/acp-transcript.test.ts` from
  `bridges/acp-bridge` passed 70/70 in 18.23 s; the affected case passed in
  1,774.68 ms.
- **Hypothesis:** the state machine reached its idle second-turn snapshot, and
  only the deliberately delayed replay lagged. Together with the ten-minute
  aggregate duration and green isolated owner, this is evidence of scheduling
  starvation around the delayed enrichment rather than transcript corruption.

## `SkillsSettings > copies the selected path and reports clipboard failures` (`apps/web/src/components/settings/SkillsSettings.test.tsx:730`)

- **Status:** open
- **Date observed:** 2026-08-28
- **Original command:** `bun run --cwd apps/web test`
- **Worker configuration:** the web package ran `bun test src --parallel` with
  Bun's default parallel worker pool.
- **Failure:** the case was reported failed after 83.61 ms. The aggregate output
  exceeded the capture budget before the assertion detail was retained.
- **Suite counts:** 5,570 total, 5,568 passed, 1 skipped, 1 failed across 244
  files in 23.95 s.
- **Isolated rerun:** `bun --cwd=apps/web test
  src/components/settings/SkillsSettings.test.tsx` -> 45 passed, 0 failed; the
  target passed in 1,572.97 ms.
- **Hypothesis:** the test waits for the component's real copy-confirmation
  timeout to restore the button before exercising the rejection path. Its
  aggregate-only failure and much longer successful isolated duration establish
  timing sensitivity, but the missing assertion detail does not identify a
  narrower cause. A recurrence should retain that assertion before changing the
  timeout or expectation.
- **Follow-up:** an immediate rerun of `bun run --cwd apps/web test` passed all
  5,569 active tests with 1 skipped across the same 244 files in 23.54 s.

## `startup completes a persisted environment rename without renderer hydration` (`apps/backend/src/core/index.test.ts:1435`)

- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:**
  `bun --cwd=apps/backend test --preload ../../tests/setup-node.ts src/core --parallel=4`
- **Worker configuration:** four Bun workers over the backend core suite.
- **Failure:** `expect(received).toContain(expected)` expected the emitted event
  list to contain `environment-renamed`, but received only `resource-changed`.
  The case failed after 873.04 ms and reproduced again after 119.29 ms.
- **Suite counts:** 2,090 total, 2,088 passed, 2 failed in the original run.
- **Isolated rerun:** the owning `index.test.ts` file passed eight consecutive
  isolated runs before the fix, confirming an aggregate timing race rather than
  a deterministic failure.
- **Hypothesis:** confirmed below; the test polled an earlier observable effect
  and then asserted a later one.
- **Root cause:** `renameEnvironmentToName` persists the environment before it
  emits `environment-renamed`. The test waited only for the stored name, so a
  parallel run could satisfy the wait in the interval before event emission.
- **Fix:** current backend-owned environment naming change; wait for the
  `environment-renamed` event, then assert the persisted name, branch, and
  cleared durable prompt.
- **Verification:** the owning file passed 26/26, and
  `bun test --preload ../../tests/setup-node.ts src/core --parallel=4 --only-failures`
  passed ten consecutive runs after the fix.

## `MultiReviewService dispatches a durable address intent without a renderer` (`apps/backend/src/core/multi-review-service.test.ts:603`)

- **Status:** open
- **Date observed:** 2026-08-27
- **Original command:** seven focused `bun test` file invocations launched
  concurrently, including `bun test ./src/core/multi-review-service.test.ts`
  from `apps/backend`.
- **Worker configuration:** seven independent Bun processes ran backend and web
  test files in parallel on the same host.
- **Failure:** after the durable address dispatch cleared
  `addressPromptPending`, the environment's `multi-review` activity source was
  still `working` instead of `idle` (duration: 154.63 ms).
- **Suite counts:** owning file — 89 total, 88 passed, 1 failed.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts` from
  `apps/backend` -> 89 passed, 0 failed; the target passed in 72.48 ms.
- **Hypothesis:** the assertion observes the activity projection immediately
  after a separate durable field becomes settled. The same activity transition
  passed in isolation, so the evidence currently supports a scheduling-sensitive
  observation under cross-process contention but does not identify which async
  boundary is late. A recurrence should capture the save and activity write
  ordering before changing the expectation.
- **Recurrence:** on 2026-08-29, `bun run test` from `apps/backend` ran 18 Bun
  workers and reported this case failed after 533.29 ms. The aggregate reported
  2,334 passed and 2 failed across 2,336 tests; the other failure was a new
  deterministic build-pipeline test corrected in the same working tree. The
  aggregate capture did not retain this case's assertion detail. An immediate
  isolated rerun, `bun test src/core/multi-review-service.test.ts`, passed all
  100 tests; the affected case passed in 44.92 ms.
- **Recurrence:** on 2026-08-31, `bun run test` ran the four groups concurrently
  and the backend workspace used two Bun workers. The case failed after 105.70
  ms with the same expected `idle` / received `working` activity mismatch. The
  backend package reported 2,357 passed and 1 failed across 2,358 tests. An
  immediate isolated rerun, `cd apps/backend && bun test --preload
  ../../tests/setup-node.ts src/core/multi-review-service.test.ts`, passed all
  100 tests; the affected case passed in 50.84 ms.

## `MultiReviewService resumes a persisted address attempt after restart` (`apps/backend/src/core/multi-review-service.test.ts:732`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-26
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; the
  failure was in the backend workspace package.
- **Failure:** the final environment snapshot was expected to contain
  `agentActivitySources: { "multi-review": { state: "idle" } }`, but the source
  and aggregate activity remained `working` after the restarted service cleared
  the persisted address attempt.
- **Suite counts:** complete run — 9,810 total, 9,796 passed, 12 skipped, 2
  failed. The other failure was the deterministic bounded-DOM assertion fixed
  in the same change.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts` from
  `apps/backend` -> 73 passed, 0 failed.
- **Hypothesis:** the isolated owner exercises the same persisted restart and
  activity transition successfully, so the observed failure depends on
  aggregate execution or timing. The available output does not establish a
  narrower shared-state or scheduling cause; a recurrence should capture the
  activity-source writes around shutdown, init, and pending-dispatch clearing.
- **Recurrence:** on 2026-08-27, `bun run test` reproduced the same expected
  `idle` / received `working` activity mismatch after 127.76 ms in the backend
  workspace group (`2,192 passed, 2 failed` across 2,194 tests). The owning file
  immediately passed 79/79 in isolation; the other aggregate failure was the
  related missing-consolidation-session case recorded below.

## `MultiReviewService fails recoverably when the consolidation session is missing` (`apps/backend/src/core/multi-review-service.test.ts:550`)

- **Status:** open
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran four test groups
  concurrently; the backend workspace package used two Bun workers.
- **Failure:** after the missing consolidation session was converted to a
  recoverable workflow failure, the environment's `multi-review` activity
  source was expected to be `idle` but remained `working` (duration: 102.14 ms).
- **Suite counts:** backend workspace group — 2,194 total, 2,192 passed, 2
  failed. The other failure was the related persisted-address recurrence above.
- **Isolated rerun:** `bun test src/core/multi-review-service.test.ts --only-failures`
  from `apps/backend` -> 79 passed, 0 failed in 5.08 s.
- **Hypothesis:** the failure has the same aggregate-only stale activity-source
  shape as the persisted-address case. The available output establishes that
  workflow failure state settled before the environment activity write became
  observable, but does not yet identify whether the cause is a delayed write or
  cross-test state; a recurrence should trace those activity-source updates.

## `MultiReviewService dispatches a durable address intent without a renderer` (`apps/backend/src/core/multi-review-service.test.ts:603`)

- **Status:** open
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite), on branch `update-environment-modal`.
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  this failure was in the backend workspace package, whose own script uses
  `--parallel=${ORKESTRATOR_TEST_WORKERS:-2}` under turbo alongside the web,
  desktop, web-public, CLI and protocol packages.
- **Failure:** 2,202 passed, 1 failed across 92 files in 42.2 s. The failing
  assertion is one of the environment activity-source transitions this test
  makes around the durable address dispatch.
- **Isolated reruns:** `bun run test:logged -- --name mr-isolate -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  src/core/multi-review-service.test.ts --only-failures` -> exit 0 in 4.9 s.
  The single test alone with `-t` -> 1 passed. The whole backend `src` suite was
  then run three more times at `--parallel=2`: 2,190 passed, 0 failed each time.
- **Relationship to the sibling entry:** this is the same file and the same
  `agentActivitySources["multi-review"]` timing shape as
  `MultiReviewService resumes a persisted address attempt after restart`,
  recorded above on 2026-08-26. Treat the two as one cluster.
- **Attribution:** the change under review refactored this service's reviewer
  fan-out into the shared `review-fanout.ts`, so this file is *not* untouched
  and the usual "unrelated diff" argument does not apply on its own. What does
  apply: the test reaches the `ready` phase — meaning the reviewer path it
  shares with the refactor completed successfully — before the assertions that
  failed, and `address`, `advanceAddressPrompt` and `syncWorkflowActivity`,
  which own those assertions, were not modified. The sibling entry predates the
  change. A recurrence should capture the activity-source writes around
  `address()` and the dispatch callback rather than the reviewer pass.
- **Recurrence (multi-model build lifecycle fixes, 2026-08-27):**
  `bun run --cwd apps/backend test` ran 18 Bun workers and reported this case
  failed after 188.74 ms; the backend package finished with 2,220 passed and 1
  failed across 93 files in 15.21 s. The captured aggregate tail did not retain
  the assertion detail. The immediate isolated rerun, `bun test
  ./src/core/multi-review-service.test.ts` from `apps/backend`, passed all 79
  cases and 335 assertions in 4.58 s; this target passed in 37.84 ms. The
  lifecycle changes in this pass do not touch `address()`, its dispatch
  callback, or `syncWorkflowActivity`, so the evidence remains consistent with
  the existing activity-source timing cluster rather than a deterministic
  reviewer-fan-out regression.
- **Recurrence (native steering bridge qualification, 2026-08-28):** a command
  intended to select one projection file appended that path to the backend
  package script instead, so Bun ran the complete backend suite with its
  default parallel worker pool. This case again observed
  `agentActivitySources["multi-review"].state` as `working` instead of `idle`
  after the durable address intent cleared (205.46 ms); that run reported 2,247
  passing and 3 failing tests across 93 files, with the other two failures both
  deterministic assertions in the new projection test and subsequently fixed.
  The correctly isolated rerun,
  `bun run test:logged -- --name steer-multi-review-isolated-3 -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/multi-review-service.test.ts`, passed. The steering changes do not
  touch Multi Review activity writes, so this remains evidence for the existing
  aggregate-only activity-projection timing cluster.

## `MultiReviewService fails recoverably when the consolidation session is missing` (`apps/backend/src/core/multi-review-service.test.ts:550`)

- **Status:** open
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete four-group repository suite).
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root,
  bridges, and protocol-lockfile groups concurrently. The backend workspace
  used `--parallel=2` inside Turbo while the other groups were active.
- **Failure:** the workflow correctly reached `failed` with the missing-session
  error and cleared its address bookkeeping, but the environment's
  `agentActivitySources["multi-review"].state` was still `working` instead of
  `idle` at the final assertion (duration: 148.09 ms).
- **Suite counts:** backend workspace — 2,220 passed, 1 failed, 8,141
  assertions across 93 files in 51.09 s. The root, bridges, and protocol
  lockfile groups passed.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts
  --test-name-pattern "fails recoverably when the consolidation session is
  missing"` from `apps/backend` -> 1 passed, 78 filtered out, 7 assertions in
  88 ms; the target passed in 62.16 ms.
- **Relationship to sibling entries:** this is the same file and final
  environment activity-source transition as the two open Multi Review address
  entries above. The workflow state assertions passed before the activity
  projection lagged, so this joins that timing cluster.
- **Hypothesis:** aggregate scheduling can leave the asynchronous environment
  activity projection one write behind the already-durable workflow failure.
  The isolated case exercises the same missing-session and cleanup path
  successfully. A fix should establish or await the activity-write ordering;
  the assertion should not be loosened.

## `opencode-client getSessionMessages > falls back to string conversion when circular tool payloads cannot be serialized` (`apps/web/src/lib/opencode-sessions.test.ts`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-25
- **Original command:** `bun run test:logged -- --name web-pkg-final -- bun run --cwd apps/web test`
- **Worker configuration:** the `apps/web` package script ran its own Bun worker
  pool over 232 files while an unrelated `apps/backend` package run was executing
  concurrently on the same host, so both pools were competing for cores.
- **Failure:** the case was reported failed after 10,245.23 ms — the shape of a
  budget overrun rather than an assertion, and roughly 240x the duration of the
  isolated run below.
- **Suite counts:** 5,385 passed, 1 skipped, 1 failed; 16,695 `expect()` calls
  across 232 files in 43.17 s.
- **Isolated rerun:** `bun --cwd=apps/web test src/lib/opencode-sessions.test.ts --parallel=2`
  -> 54 passed, 0 failed. The target passed.
- **Attribution:** observed while changing setup-tab retirement in
  `apps/web/src/components/terminal/TerminalContainer.view.tsx` and the setup
  session snapshot in `apps/backend/src/core/commands-registry-environments.ts`.
  Neither file is imported by `opencode-sessions.ts` or its test, and the same
  file passed in the immediately preceding full-suite run of the same commit
  (`bun run test`, workspace group status 0). The two share only host capacity.
- **Hypothesis:** the case builds a deliberately circular tool payload and
  drives the serializer's failure path, so its cost is CPU-bound rather than
  I/O-bound and it degrades directly with host contention. A recurrence should
  record the case's duration under a quiet host before touching the budget; a
  genuine regression in the fallback would fail on the assertion rather than at
  a timeout.

## `NativeAgentService > retries once past a parked dispatch the provider can now vouch for` (`apps/backend/src/core/native-agent-service-dispatch.test.ts:767`)

- **Status:** open — targeted stress has not identified a root cause or fix
- **Date observed:** 2026-08-25
- **Original command:**
  `bun --cwd apps/backend test src/core/http-bridge-provider.test.ts`; the
  package script expanded this to
  `bun test --preload ../../tests/setup-node.ts src tests --parallel src/core/http-bridge-provider.test.ts`.
- **Worker configuration:** the backend package ran 18 Bun workers over `src`
  and `tests`; the trailing file argument did not narrow the package script.
- **Failure:** the case was reported failed after 32.48 ms. The direct command
  output exceeded the capture budget before Bun's assertion detail, so no
  failure message was retained.
- **Suite counts:** 2,057 total, 2,048 passed, 9 failed, 7,525 `expect()` calls
  across 80 files in 10.66 s. Eight sibling failures were in the standalone
  backend process suite and match existing environment/process-lifecycle
  entries in this file.
- **Isolated rerun:**
  `bun test src/core/native-agent-service-dispatch.test.ts --preload ../../tests/setup-node.ts --test-name-pattern 'retries once past a parked dispatch'`
  from `apps/backend` -> 1 passed, 62 filtered out, 4 `expect()` calls in 28 ms;
  the target passed in 12.65 ms.
- **Attribution:** the change in flight adds Pi bridge composer rehydration and
  makes the HTTP bridge provider's explicit Pi catalogue refresh call the Pi
  bridge. This case uses a Cursor provider stub directly through
  `NativeAgentService`; it never constructs `HttpBridgeProvider` and does not
  load the Pi bridge.
- **Hypothesis:** the evidence establishes an aggregate-only failure but not
  its mechanism because the assertion detail was truncated. A recurrence needs
  the complete assertion and surrounding worker output before changing the
  dispatch reconciliation logic or its expectations.

## `ACP bridge > counts in-flight creation reservations against the session cap` (`bridges/acp-bridge/src/acp-server.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside the bridges group, 3,091 tests across 115 files in 61.63 s.
- **Failure:** the case timed out at 5,059.00 ms. The bridges group reported two failures in that run; the other one, `reaps a session process when the creating HTTP client disconnects`, reproduces in isolation and is a separate, non-flaky problem (see Attribution).
- **Suite counts:** bridges group — 3,078 passed, 11 skipped, 2 failed; 9,913 `expect()` calls.
- **Isolated rerun:** `bun run test:logged -- --name rerun-acp -- bun test bridges/acp-bridge/src/acp-http.test.ts` → 5 passed, 1 failed, 37 `expect()` calls in 5.76 s. This case **passed**; only `reaps a session process when the creating HTTP client disconnects` failed, at 5,067.86 ms.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** `bun run test`
  timed out at the same `waitFor` after 5,053.98 ms; the bridges group
  reported 3,111 passed, 11 skipped, and 2 failed across 115 files. The
  isolated owner rerun,
  `bun test ./src/acp-http.test.ts ./src/acp-server.test.ts --only-failures`
  from `bridges/acp-bridge`, passed all 15 tests in 1.23 s.
- **Attribution:** observed while changing `apps/web` action-default resolution and `packages/protocol/src/action-defaults.ts`. Neither file is reachable from the ACP bridge, so the two share only host capacity. The host ran Bun 1.4.0 against the repo's pinned `bun@1.3.14`, and the same run produced six root-group failures that all reproduce in isolation — treat this observation as coming from a toolchain-mismatched host.
- **Hypothesis:** the case holds creation reservations open to prove they count against the session cap, so it is waiting on real bridge child processes under the generic 5-second budget. Under group-level contention those spawns miss the window, which is the same shape as the `announces overflow…` entry above in the same file. A recurrence should time the reservation's spawn-to-counted interval under load before widening the budget; a genuine cap regression would fail deterministically rather than at exactly the timeout.
- **Recurrence (Electron production logging, 2026-08-25):** `bun run test`
  timed out this case at 5,057.18 ms in its current owner,
  `bridges/acp-bridge/src/acp-server.test.ts`. The bridges group reported
  3,111 passed, 11 skipped, and 2 failed across 115 files in 60.65 s. The
  isolated rerun `bun test ./src/acp-server.test.ts` from
  `bridges/acp-bridge` passed all 9 tests in 0.884 s, with the target taking
  47.74 ms. The change in flight touched Electron logging, backend log-file
  management, shared retention validation, and the Settings UI; none is in
  the ACP bridge process path.
- **Bun 1.4 reproduction:** after the test moved to `acp-server.test.ts`, `bun test bridges/acp-bridge/src/acp-server.test.ts` reproduced the timeout in isolation at 5,044.75 ms (8 passed, 1 failed). The related disconnect case also reproduced in isolation in `acp-http.test.ts` at 5,043.46 ms (5 passed, 1 failed).
- **Root cause:** the repository preload replaces the Web APIs with Happy DOM's implementations. These two tests passed Happy DOM `AbortSignal` instances to `Bun.fetch`; Bun 1.4 validates the signal's native brand, rejects before sending either request, and leaves the lifecycle-file waits polling empty files until timeout.
- **Fix:** preserve Bun's native fetch and abort constructors before Happy DOM registration, then use that matched pair for the aborting ACP integration requests.
- **Verification:** `bun test bridges/acp-bridge/src/acp-http.test.ts` passed 6 tests with 40 assertions in 589 ms, and `bun test bridges/acp-bridge/src/acp-server.test.ts` passed 9 tests with 28 assertions in 853 ms under Bun 1.4.0. The subsequent complete `bun run test` passed all four concurrent groups in 87.3 s.

## `ACP bridge > reaps a session process when the creating HTTP client disconnects` (`bridges/acp-bridge/src/acp-http.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; this
  failed in the bridges group.
- **Failure:** `Timed out waiting for ACP state: ""` from
  `acp-test-harness.ts:160` after 5,054.57 ms.
- **Suite counts:** bridges group — 3,111 passed, 11 skipped, 2 failed; 3,124
  tests across 115 files in 60.65 s.
- **Isolated rerun:** `bun test ./src/acp-http.test.ts` from
  `bridges/acp-bridge` -> 6 passed, 0 failed, 40 `expect()` calls in 0.519 s;
  the target passed in 68.36 ms.
- **Hypothesis:** the case waits for a real bridge child process to observe the
  disconnected creator and reap its session. Its isolated runtime is two
  orders of magnitude below the fixed aggregate deadline, while the sibling
  reservation test failed at the same five-second boundary in the same run.
  This was initially consistent with group-level process starvation.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** the same test
  timed out after 5,049.72 ms in a `bun run test` bridges group with 3,111
  passed, 11 skipped, and 2 failed across 115 files. The isolated rerun
  `bun test ./src/acp-http.test.ts ./src/acp-server.test.ts --only-failures`
  from `bridges/acp-bridge` -> 15 passed, 0 failed, 68 `expect()` calls in 1.23
  s.
- **Bun 1.4 reproduction:** `bun test bridges/acp-bridge/src/acp-http.test.ts`
  reproduced the timeout in isolation at 5,043.46 ms (5 passed, 1 failed).
- **Root cause:** the repository preload replaces the Web APIs with Happy DOM's
  implementations. This test passed a Happy DOM `AbortSignal` to `Bun.fetch`;
  Bun 1.4 validates the signal's native brand, rejects before sending the
  request, and leaves the lifecycle-file wait polling an empty file until
  timeout.
- **Fix:** preserve Bun's native fetch and abort constructors before Happy DOM
  registration, then use that matched pair for the aborting ACP integration
  request.
- **Verification:** `bun test bridges/acp-bridge/src/acp-http.test.ts` passed 6
  tests with 40 assertions in 589 ms under Bun 1.4.0. The subsequent complete
  `bun run test` passed all four concurrent groups in 87.3 s.

## `ACP bridge > announces overflow when earlier stream chunks leave no room for the marker` (`bridges/acp-bridge/src/acp-http.test.ts:191`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-24
- **Original command:** `bun run test:logged -- --name final6 -- bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside the bridges group, 2,833 tests across 99 files in 68.71 s.
- **Failure:** `Timed out waiting for ACP state: false` thrown from `waitFor` in `acp-test-harness.ts:160`, reached through `spawnBridge` (`acp-test-harness.ts:212`) at `acp-http.test.ts:191` (duration: 15,004.97 ms). The failure is in the harness's bridge startup wait, not in the overflow assertion the case exists to make.
- **Suite counts:** bridges group — 2,821 passed, 11 skipped, 1 failed; 9,324 `expect()` calls.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-http.test.ts` → 6 passed, 0 failed, 40 `expect()` calls in 0.81 s.
- **Attribution:** observed while adding `bridges/cursor-bridge`, a separate package. The change touches no ACP bridge source, and the ACP suite's own files are unmodified, so the two share only host capacity.
- **Hypothesis:** `spawnBridge` boots a real bridge process plus a fake agent and polls it for readiness against a 15-second budget. The bridges group now starts one more package's processes alongside the existing ones, so under contention the spawn can miss that window while the bridge is still coming up — the `false` in the message is the readiness predicate never turning true, not a bad response. A recurrence should time the harness's spawn-to-healthy interval under load before widening the budget, since a genuine startup regression would look identical from the outside.

## `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-terminal.test.ts:1571`)

- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run concurrently with three typechecks and two other Bun test groups on the same host. A separate observation used the root group only, four Bun workers.
- **Failure:** `expect(received).toThrow(expected)` with `Expected substring: "Malformed"`; the received message was `Command failed: docker exec container-1 bash -lc ...`, and the log also recorded `this test timed out after 5000ms` (duration: 5,013.59 ms). A paired observation reported duration 5,002.30 ms with the fake `docker exec` echoing the whole git-status script back as a failure and `killed 1 dangling process`.
- **Suite counts:** 3,726 passed, 1 skipped, 2 failed; 16,602 expect() calls, 238.8 s. A second observation of the same pair recorded 3,726 passed, 1 skipped, 2 failed, 2 errors, 16,592 `expect()` calls; 3,729 tests across 178 files in 359.91 s.
- **Isolated rerun:** `bun test tests/unit/electron/commands-registry-terminal.test.ts` → passed in 23.0 s. A logged rerun `bun run test:logged -- --name rerun-terminal -- bun test tests/unit/electron/commands-registry-terminal.test.ts` → passed in 25.6 s.
- **Follow-up:** A later `--parallel=4` run of the same command on a quieter host passed in 79.2 s without this failure.
- **Recurrence (2026-08-26):** `bun run test` failed this case after the generic
  5,000 ms deadline while `scripts/test-all.ts` ran its four validation groups
  concurrently. The root/agent-support group reported 3,841 passed, 1 skipped,
  1 failed, and 1 trailing error across 3,843 tests; the complete run reported
  15,234 passed and 13 skipped. The expected `"Malformed"` rejection was again
  replaced by a `CommandFailedError` echoing the fake Docker command after the
  fixture crossed the deadline. The isolated rerun
  `bun test tests/unit/electron/commands-registry-terminal.test.ts` passed all 64
  runnable tests with 1 skipped in 18.43 s; the target case completed in
  365.72 ms. The change under validation touched only two DOM absence
  assertions in `tests/unit/components/GlobalSettings.test.tsx`.
- **Hypothesis:** The case drives a real fake-`docker` child process against the generic 5-second outer budget. Under host contention the fake process did not return before the outer timeout, so the timeout message replaced the expected `Malformed` rejection. This matches the 2026-08-16 sweep's command-registry row, which gave sibling cases explicit budgets; this case appears not to have received one. A recurrence should give the case an explicit budget and capture the fixture's process timing rather than loosening the `Malformed` assertion, which is the actual product behaviour under test.
- **Root cause:** The test launches four sequential fake-Docker subprocess
  fixtures but used Bun's generic 5-second per-test deadline. Under aggregate
  process contention, the outer deadline interrupted the test and tore down the
  active shim before the expected malformed-framing rejection completed.
- **Fix:** This change gives the case the existing shared
  `ASYNC_TEST_BUDGET_MS` budget used by neighboring subprocess-backed tests; the
  product assertion and malformed inputs are unchanged.
- **Verification:** The target passed three consecutive focused runs via
  `bun test tests/unit/electron/commands-registry-terminal.test.ts --test-name-pattern
  "rejects malformed container status framing" --rerun-each 3` (737.98 ms,
  349.62 ms, and 362.42 ms). The subsequent `bun run test` passed all four
  groups with 15,235 passed, 13 skipped, and 0 failed; typecheck, build,
  formatting, and lint also passed.

## `remote gateway > keeps a slow but progressing proxy body alive past the idle timeout` (`tests/unit/electron/gateway-proxy.test.ts:674`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run concurrently with three typechecks and two other Bun test groups on the same host.
- **Failure:** `expect(received).toBe(expected)`, `Expected: 200`, `Received: 502` (duration: 315.30 ms).
- **Suite counts:** as above — 3,726 passed, 1 skipped, 2 failed.
- **Isolated rerun:** `bun test tests/unit/electron/gateway-proxy.test.ts` → passed in 1.0 s.
- **Follow-up:** A later `--parallel=4` run of the same command passed in 79.2 s without this failure.
- **Hypothesis:** The case drives a deliberately slow proxy body and asserts the idle timer treats forward progress as liveness. Under contention the gaps between the test's own body chunks can exceed the configured idle window, so the gateway legitimately aborts and returns 502. A recurrence should widen the chunk cadence relative to the idle timeout rather than accepting a 502, because tolerating it would stop testing the behaviour.

## `ActionBar toolbar interactions > runs commands and opens the editor from keyboard shortcuts` (`apps/web/src/components/layout/ActionBar.test.tsx:1704`)

- **Status:** open — recurred after the 2026-08-27 resolution sweep
- **Date observed:** 2026-08-17
- **Original command:** `bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside `@orkestrator/web:test:workspace`, 5,095 tests across 222 files in 118.5 s.
- **Failure:** a mock assertion reporting the expected call arguments followed by `But it was not called.` (duration: 47.14 ms).
- **Suite counts:** web workspace group — 1 skipped, 1 failed; the root, bridges, and codex-protocol-lockfile groups all passed.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` → 171 passed in 17.3 s. Also passed under `--parallel=4` (16.0 s), and passed on a stashed working tree at `4d25c8ea` with no local changes, so it is not attributable to the branch under test.
- **Recurrence (action-bar launch-dialog defaults review, 2026-08-24):** `bun run test:logged -- --name web-package-tests2 -- bun --cwd=apps/web test --parallel=4 --only-failures` reproduced the identical signature at `ActionBar.test.tsx:1767` — `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })` followed by `But it was not called.` (duration: 48.19 ms), matching the 47.14 ms original. Web package: 1 failed across 232 files, 5,327 tests in 45.88 s. Two immediate re-runs of the same command passed (45.7 s), and the isolated rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed 187/187 in 16.20 s. The reviewed change adds tests to the same file but only below line 4340, so it cannot reorder or affect this case, which sits at line 1752. Evidence: `web-package-tests2.log.gz` in the run's `orkestrator-test-run.*` log directory.
- **Recurrence (pi reconnect review, 2026-08-25):** `bun run test:logged -- --name full-suite-final -- bun run test` failed the web workspace group on the same assertion in a *different* case in the same file — `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5089`, `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })` (duration: 45.81 ms). The mock had recorded three calls (`plain`, `agent-native`, `codex`), so the earlier shortcuts in the sequence did fire and only the one under assertion was missed, which fits the handler-installation hypothesis below rather than a wholesale failure to mount. Web package: 5,375 passed, 1 skipped, 1 failed across 232 files in 66.62 s. The isolated rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed 188/188, and a full re-run of `bun --cwd=apps/web test --parallel=4 --only-failures` passed in 32.8 s. An earlier `bun run test` on the same branch passed this group outright. Evidence: `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under `/var/folders/.../orkestrator-test-run.PHvwPq`.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** `bun run test`
  failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` after 26.31 ms. The web workspace
  group reported 5,379 passed, 1 skipped, and 1 failed across 232 files. The
  isolated rerun,
  `bun test ./src/components/layout/ActionBar.test.tsx --only-failures` from
  `apps/web`, passed all 189 tests in 12.37 s.
- **Recurrence (Cursor SDK-only migration, 2026-08-26):** `bun run test`
  failed the same keyboard-shortcut case after 23.36 ms on
  `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands:
  ["bun test"] })`. The mock contained the preceding plain, native-agent, and
  review-tab calls, but not the run-command call. The web workspace group
  reported 5,466 passed, 1 skipped, and 3 failed across 236 files; the other two
  failures were stale Cursor CLI expectations fixed in the same change. The
  isolated rerun `bun test src/components/layout/ActionBar.test.tsx` from
  `apps/web` passed all 190 tests with 728 assertions in 12.84 s, including the
  target in 14.89 ms.
- **Recurrence (retry-gate review follow-up, 2026-08-25):** the same case failed
  again on the next `bun run test` for that branch, at `ActionBar.test.tsx:5170`
  after 51.07 ms, alongside `opens the Resolve modal after a mobile long press
  without launching a default resolve` in the same file. The web workspace group
  reported 5,393 passed, 1 skipped, and 2 failed across 233 files. The isolated
  rerun `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  passed 189/189 in 14.54 s. Two distinct cases in one file failing together,
  both of which pass alone, points at the whole file losing its wall-clock
  budget rather than at either assertion.
- **Recurrence (control MCP review fixes, 2026-08-26):** `bun run test` failed
  `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow,
  editor, and panel shortcuts` at `ActionBar.test.tsx:5170` after 23.68 ms. The
  expected `createTabMock("plain", { initialCommands: ["bun test"] })` call was
  absent even though the mock recorded the preceding plain, native-agent, and
  Codex tab calls. The web workspace group reported 5,439 passed, 1 skipped,
  and 1 failed across 235 files in 63.11 s; the other aggregate groups passed.
  The isolated rerun
  `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --timeout 30000`
  passed 189/189 in 12.79 s, with the target case completing in 14.64 ms. The
  reviewed change only replaces ActionBar's tab-cap literal source with a shared
  constant whose value remains 9; it does not touch run-command loading or the
  shortcut payload. Evidence: the `workspace-web-backend-desktop-web-public-cli-protocol`
  log under `/var/folders/.../orkestrator-test-run.qXZvbG`.
- **Recurrence (Multi Review fix transcript follow-up, 2026-08-27):** `bun run
  test` failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5212` after
  27.81 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent, while the mock recorded the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,507 passed, 1 skipped, and 1 failed across 240 files in 69.45 s; the root,
  bridges, and protocol-lockfile groups passed. The isolated rerun `bun test
  src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`
  passed all 190 tests with 727 assertions in 14.47 s. The reviewed change does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.IB45Lu`.
- **Recurrence (backend environment naming, 2026-08-27):** a second `bun run
  test` failed the same keyboard-shortcut case at `ActionBar.test.tsx:5450`
  after 30.31 ms. The expected run-command call was absent while the mock again
  contained the preceding plain, native-agent, and Codex review-tab calls. The
  web workspace group reported 5,531 passed, 1 skipped, and 1 failed across 242
  files; the other three top-level groups passed. The immediate isolated rerun,
  `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`, passed
  198/198 with 770 assertions in 14.59 s; the target passed in 21.45 ms. The
  environment-naming change does not touch `ActionBar`, its shortcut handler,
  or run-command loading.
- **Recurrence (Multi Review teardown review fixes, 2026-08-27):** `bun run
  test` failed the same keyboard-shortcut case at `ActionBar.test.tsx:5452`
  after 23.84 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,543 passed, 1 skipped, and 1 failed across 242 files in 68.29 s; the backend
  workspace and every other full-suite group passed. The isolated rerun `bun
  test src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`
  passed all 198 tests with 770 assertions in 14.85 s. The reviewed change does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.CkFtcL`.
- **Recurrence (agent messaging implementation, 2026-08-28):** `bun run test`
  failed `ActionBar keyboard shortcuts and tab guards > dispatches tab,
  workflow, editor, and panel shortcuts` at `ActionBar.test.tsx:5452` after
  14.06 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,561 passed, 1 skipped, and 1 failed across 243 files in 66.17 s; the
  backend workspace and the root, bridge, and protocol-lockfile groups passed.
  The immediate isolated rerun, `bun test
  src/components/layout/ActionBar.test.tsx --only-failures` from `apps/web`,
  passed all 198 tests with 770 assertions in 14.81 s. The implementation does
  not touch ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.qqfO2R`.
- **Recurrence (agent messaging review fixes, 2026-08-28):** `bun run test`
  failed the same keyboard-shortcut case at `ActionBar.test.tsx:5452` after
  24.89 ms. The expected `createTabMock("plain", { initialCommands: ["bun
  test"] })` call was absent while the mock contained the preceding plain,
  native-agent, and Codex review-tab calls. The web workspace group reported
  5,572 passed, 1 skipped, and 1 failed across 245 files in 65.61 seconds; the
  backend workspace and the root, bridge, and protocol-lockfile groups passed.
  The immediate isolated rerun, `bun test
  src/components/layout/ActionBar.test.tsx` from `apps/web`, passed all 198
  tests with 772 assertions in 14.27 seconds. The review fixes do not touch
  ActionBar or its shortcut handler. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.KTh5f2`.
- **Recurrence (feature activation, 2026-08-29):** `bun run test` failed the
  same `dispatches tab, workflow, editor, and panel shortcuts` case at
  `ActionBar.test.tsx:5467` after 118.84 ms. The expected run-command call was
  absent while the mock again contained the preceding plain, native-agent, and
  Codex review-tab calls. The web workspace reported 5,577 passed, 1 skipped,
  3 failed, and 1 trailing error across 5,581 tests; the aggregate runner also
  stretched unrelated timer cases into multi-minute durations. The isolated
  rerun `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`
  exited 0 against the same tree.
- **Recurrence (colour-scheme adoption, 2026-08-30):** `bun run test` failed
  the same `dispatches tab, workflow, editor, and panel shortcuts` case at
  `ActionBar.test.tsx:5467` after 19.56 ms. The expected `createTabMock("plain",
  { initialCommands: ["bun test"] })` call was absent while the mock again
  contained exactly the preceding plain, native-agent, and Codex review-tab
  calls (`Number of calls: 3`). The web workspace group was the only failing
  group besides two palette assertions fixed in the same change; the bridge and
  protocol-lockfile groups passed. The immediate isolated rerun, `bun
  --cwd=apps/web test src/components/layout/ActionBar.test.tsx`, passed all 198
  tests with 773 assertions in 14.12 s. The reviewed change restyles the
  toolbar's Create PR placement and the shared button variants but does not
  touch the shortcut handler or run-command loading. Evidence:
  `workspace-web-backend-desktop-web-public-cli-protocol.log.gz` under
  `/var/folders/.../orkestrator-test-run.pHJVhH`.
- **Hypothesis:** The case dispatches a keyboard shortcut and asserts the resulting command mock synchronously. Under renderer contention the React commit that installs the shortcut handler can land after the key event is dispatched, so the handler never runs. A recurrence should wait for the control the shortcut targets to be mounted before dispatching, rather than relaxing the call assertion.

## `ACP bridge > drops malformed persisted tool parts on load` (`bridges/acp-bridge/src/acp-persistence.test.ts:419`)

- **Status:** open
- **Date observed:** 2026-08-28
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; the
  bridge group used two Bun workers.
- **Failure:** bridge startup timed out after 15 seconds in
  `acp-test-harness.ts:200` with `Timed out waiting for ACP state: false` while
  the case restarted the bridge at `acp-persistence.test.ts:474` (duration:
  15,004 ms).
- **Suite counts:** bridge group — 3,151 passed, 11 skipped, and 1 failed across
  118 files in 66.64 seconds. The workspace, root/agent-support, and
  protocol-lockfile groups passed.
- **Isolated rerun:** `bun test src/acp-persistence.test.ts` from
  `bridges/acp-bridge` passed all 12 tests with 61 assertions in 1.02 seconds;
  the target passed in 28.94 ms.
- **Hypothesis:** This has the same aggregate-only bridge-startup signature as
  the existing ACP readiness family: the persisted-state assertion did not
  fail, because the replacement bridge never became healthy within the harness
  deadline. A recurrence should capture child startup and shutdown timing before
  changing either the malformed-part expectations or the readiness budget.

## `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts:650`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** root group only, four Bun workers.
- **Failure:** `this test timed out after 5000ms` (duration: 5,021.67 ms). The paired unhandled error reported between tests was an expected-to-resolve promise rejecting: `commands.get("merge_pr_local")?.({ environmentId, method: "squash", deleteBranch: false })` was expected to resolve to `{ outcome: "merged" }`. The file also logged `killed 1 dangling process`.
- **Suite counts:** as above — the two failures and two errors in that run are these entries.
- **Isolated rerun:** `bun run test:logged -- --name rerun-pr -- bun test tests/unit/electron/commands-registry-pr.test.ts` → passed in 32.5 s.
- **Recurrence:** `bun run test:logged -- --name fix-review-full-suite-final -- bun run test` timed out at the same assertion after 5,016.38 ms while the concurrent workspace, bridges, and protocol-lockfile groups passed (root/agent-support: 3,772 passed, 1 skipped, 1 failed, 1 error across 181 files). The owning-file rerun, `bun run test:logged -- --name isolate-commands-registry-pr -- bun test tests/unit/electron/commands-registry-pr.test.ts --only-failures`, passed in 13.6 s. The reviewed change only affects the web scroll-state hook and its tests, so this recurrence remains unrelated and contention-shaped.
- **Hypothesis:** Same shape as the terminal entry — a real fake-`gh`/Git fixture racing the generic 5-second budget under contention, with the paired `merge_pr_local` rejection being the fixture failing rather than the draft-parsing behavior under test. Both entries were observed while reviewing `model-platform-detection`, whose diff touches only `apps/web`, an ACP bridge tsconfig, and Claude bridge test fixtures — nothing either file imports. Because these are timeouts rather than assertion mismatches, an isolated rerun alone does not fully exclude a genuine slowdown; a recurrence should time the fixture's process startup before adjusting budgets.

## `Electron backend process supervisor > reports backend readiness before slow managed Serve initialization finishes` (`tests/unit/electron/backend-process.test.ts`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Direction:** the inverse of this file's usual pattern — it failed *in isolation* and passed in the aggregate suite, so it is recorded here rather than dismissed.
- **Original command:** `bun run test:logged -- --name cred-focused2 -- bun test tests/unit/electron/backend-process.test.ts tests/unit/claude-credential-injection.test.ts --parallel=2 --only-failures`
- **Worker configuration:** two Bun workers over two files, while an isolated `dev:test` profile (`agent-cred-inject`) was live on the same machine.
- **Failure:** `Unable to inspect Tailscale Serve configuration: Command failed: <tmp>/tailscale serve status --json` from `apps/backend/src/tailscale-serve.ts:176` via `managed-web-client.ts:170` (duration: 7,977.82 ms).
- **Suite counts:** 54 passed, 1 failed; 55 tests across 2 files.
- **Isolated rerun:** `bun test tests/unit/electron/backend-process.test.ts -t "reports backend readiness before slow managed Serve initialization finishes"` → also failed (7,439.62 ms), and failed identically on a stashed clean tree (8,964.33 ms), confirming it is not caused by the credential-injection change on this branch.
- **Follow-up:** after the live `dev:test` profile finished starting, the owning file passed alone (32 passed, 14.18 s) and the complete aggregate `bun run test` passed in 104.9 s.
- **Recurrence:** during credential-isolation follow-up on the same date, `bun test tests/unit/electron/backend-process.test.ts --parallel=2 --only-failures` failed at `waitForPath(.../status-started)` after 7,182.99 ms (27 passed, 1 failed); an immediate single-test rerun with `-t "reports backend readiness before slow managed Serve initialization finishes"` passed in 7.1 s.
- **Aggregate recurrence:** `bun run test` at `ea9d79bdfdd3b2d4f5e0754b1ed6d2adf619e98e` timed out at the same `status-started` wait after 5,497.76 ms; the exact test passed alone in 3.1 s.
- **Recurrence (2026-08-27):** `bun run test` timed out waiting for
  `status-started` after 10,448.97 ms. The owning file then passed alone: 29
  tests, zero failures.
- **Hypothesis:** the case drives real backend startup against a fake `tailscale` shim in a temp directory. Concurrent process pressure from a starting `dev:test` profile appears to make the shim invocation fail rather than merely run slowly, so the failure is contention-shaped like the existing "Standalone backend shutdown and Tailscale Serve lifecycle" family. A recurrence should capture whether the shim was ever created and whether the failure is a spawn error or a non-zero exit before changing the Serve assertions.

## Aggregate process-contention recurrences (credential-isolation follow-up)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name final-full-test -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the root group used four Bun workers and the bridges group used two.
- **Failures:** `agent completion immediately rechecks and clears a resolved conflict` timed out after 3,028.60 ms waiting for the immediate PR recheck; `runtime helper preserves caller PATH additions in non-interactive bash` timed out after 5,662.98 ms; `rejects malformed container status framing and invalid encoded sections` timed out after 5,009.79 ms and its interrupted fixture produced a follow-on assertion error; `hard-kills a process that exceeds stdout and file-output limits` timed out after 5,511.94 ms.
- **Suite counts:** backend workspace: 1,892 passed and 1 failed across 73 files; root/agent-support: 3,742 passed and 4 failed across 180 files (two are listed here, one is the separately recorded backend-readiness recurrence, and one was an outdated changed-code fixture corrected in this follow-up); bridges: 2,649 passed and 1 failed across 91 files.
- **Isolated reruns:** each exact failed test passed alone through `test:logged`: PR recheck in 0.6 s, runtime environment in 0.7 s, malformed framing in 2.1 s, and Codex title limit in 0.5 s.
- **Second aggregate run:** `bun run test` at `26c100220c905c67fa8efe3a12f606c90e610d1a` passed the complete workspace group, then the six-worker root group reported 3,742 passed and 4 timed-out tests after 268.8 s. The malformed-framing and backend-readiness cases recurred; `stops local merges when draft inspection or readiness fails` and `treats empty, null, and non-boolean draft output as non-draft` were newly observed at 5,017.69 ms and 5,001.10 ms. Those two exact PR tests passed alone in 2.4 s and 3.4 s respectively.
- **Recurrence (2026-08-27):** `bun run test` reported 3,848 passed, one
  skipped, five failed, and three associated errors in the root group. The
  failures were the Linux file-manager fallback; three direct-container Claude
  credential cases in `commands-registry-docker.test.ts`; and backend readiness.
  The three owning files passed alone (61/61, 12/12, and 29/29).
- **Hypothesis:** these cases cross real timer or subprocess boundaries and exhausted generic aggregate budgets while the independently scheduled groups competed for process startup. The isolated passes confirm this observation as contention-shaped; recurrence counts should be gathered before changing product assertions.

## Root-suite 5000 ms timeout cluster (`tests/unit/electron/`, `tests/unit/test-diagnostic-bounds.test.ts`)

Three tests failed together in one root-suite run, and three further runs each
failed a different subset. They are recorded as one entry because the evidence
points at a single shared cause — starvation against a fixed 5000 ms deadline —
rather than independent defects. Every owning file passes alone, and the failing
set is not stable between runs, which is the signature this registry already
records for the `tmux-backend.test.ts` and `standalone.test.ts` clusters below.

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4`
- **Worker configuration:** `--parallel=4` (which implies `--isolate`). Run concurrently with a second `bun test --test-worker` fleet from another worktree on the same host; load average during the run was 18.67 / 27.53 / 21.07.
- **Suite counts:** 3,733 passed, 1 skipped, 3 failed, 2 non-fatal between-test errors; 179 files in 341.4 s (exit 1).
- **Failures:**
  - `remote gateway > keeps a slow but progressing proxy body alive past the idle timeout` (`tests/unit/electron/gateway-proxy.test.ts:674`) — `expect(received).toBe(expected)`, expected `200`, received `502`.
  - `remote gateway > serializes invoke results once and keeps command metrics private and bounded` (`tests/unit/electron/gateway-support-extra.test.ts`) — timed out after 5000 ms (5034.33 ms), with an unhandled `ECONNREFUSED` between tests.
  - `Electron backend command registry > clears a stale failure only once the stop has actually committed` (`tests/unit/electron/commands-registry-environments.test.ts:3892`) — expected a promise that resolves, received one that rejected; timed out after 5000 ms (5002.20 ms).
- **Isolated reruns:** `bun test tests/unit/electron/gateway-proxy.test.ts` → passed, exit 0, 1.7 s. `bun test tests/unit/electron/gateway-support-extra.test.ts` → passed, exit 0, 2.1 s. `bun test tests/unit/electron/commands-registry-environments.test.ts` → also failed alone, but on **two different tests** than the aggregate run; all three originally-failing tests passed when selected individually with `-t`.
- **Recurrence (2026-08-17, same day):** Three further `bun test ./tests --parallel=4` runs on an otherwise idle host, each failing a **different** subset of 5000 ms-deadline tests:
  - Run 1 — none of this cluster failed.
  - Run 2 — `remote gateway > serializes invoke results once and keeps command metrics private and bounded` (5059.89 ms). 3,741 passed, 1 skipped, 1 failed, 179 files, 244.2 s. Isolated rerun of `gateway-support-extra.test.ts` → 23 passed, 0 failed, in **1.03 s**.
  - Run 3 — `bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull` (`tests/unit/test-diagnostic-bounds.test.ts`, 5011.17 ms) and `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-environments.test.ts`, 5006.02 ms). 3,740 passed, 1 skipped, 2 failed, 361.4 s. Both owning files passed alone: 12 passed in 2.18 s, and 114 passed in 43.40 s.
- **Recurrence (2026-08-17, `claude-task-layout`):** one further occurrence of the same 5000 ms-deadline cluster, in the full four-group `scripts/test-all.ts` run rather than the root group alone: `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`commands-registry-terminal.test.ts`, 5018.26 ms), alongside `scripts/test-all.ts > the non-iOS groups run concurrently, not one after another` (1008.70 ms) — see that test's own entry. The run took 229.6 s against ~137 s for the same command minutes earlier on the same tree, so the host was materially slower; both owning files passed alone immediately afterwards (64 passed and 32 passed, exit 0). No new evidence about mechanism, and the change under review touched only transcript settle positions in `apps/web`, `apps/backend/src/core/http-bridge-provider.ts`, `bridges/claude-bridge` message normalization and the protocol summary — none of which these files load.
- **Recurrence (2026-08-27):**
  `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
  reported 3,845 passed, one skipped, two failed, and two associated errors
  across 185 files in 237.76 s. `verifies a PR against the trusted project and
  environment branches` timed out at 5,021.86 ms, and `falls back to the parent
  directory when Linux FileManager1 fails` timed out at 5,001.17 ms. Their
  combined isolated rerun passed 117 tests in 14.23 s.
- **Widened scope:** run 3 shows the cluster is not confined to the gateway and command-registry files. `test-diagnostic-bounds.test.ts` walks every test file in the repository and needs 2.18 s even alone, so it sits close to the 5000 ms deadline before any contention is added; it is the clearest example of a deadline that is too tight for the work rather than a test that hangs. A test needing 1–2 s alone but exceeding 5 s under `--parallel=4` is being starved.
- **Hypothesis:** All three are fixed-deadline (5000 ms) assertions in files that spawn child processes and bind loopback ports. Under the observed load they lose the CPU long enough to cross the deadline, and the gateway proxy's `502` is the same starvation surfacing as an upstream connect failure rather than a timeout. The `commands-registry-environments.test.ts` file failing on a *different* pair of tests in isolation is the strongest evidence that the deadline, not any one test's logic, is what is being hit. A fix should replace the fixed deadlines in these three files with progress-based waits, or raise them proportionally to detected host load; do not simply widen the constant, which moves the threshold without removing the race.
- **Not attributable to the change under review:** the diff that surfaced this (`packages/protocol/src/action-defaults.ts` and the settings/toolbar wiring) touches none of these files or the code they exercise.
- **Recurrence (2026-08-27, `update-environment-modal`):** six of this cluster failed together in one `bun run test` (root and agent-support group: 3,853 passed, 1 skipped, 6 failed, 3 non-fatal between-test errors, 187 files in 211.7 s; the workspace, bridges and protocol-lockfile groups all passed). Every one was a 5,00x ms timeout:
  - `Electron backend command registry > keeps the stored branch when a container rollback outcome cannot be established` (`tests/unit/electron/commands-registry-environments.test.ts:2216`, 5,005.26 ms)
  - `Electron backend command registry > keeps the stored branch when a container rollback fails and the container is unreachable` (`tests/unit/electron/commands-registry-environments.test.ts:2276`, 5,003.91 ms)
  - `Electron backend command registry > stops container merges when draft inspection or readiness fails` (`tests/unit/electron/commands-registry-pr.test.ts:472`, 5,002.42 ms)
  - `Electron backend command registry > stops local merges when draft inspection or readiness fails` (`tests/unit/electron/commands-registry-pr.test.ts`, 5,022.30 ms)
  - `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts`, 5,025.65 ms)
  - `Electron backend command registry > reports whether the selected host GitHub CLI credential is available` (`tests/unit/electron/commands-registry-tools.test.ts:840`, 5,010.40 ms)

  All three owning files passed alone immediately afterwards: `bun run test:logged -- --name env-registry -- bun test ./tests/unit/electron/commands-registry-environments.test.ts --only-failures` -> exit 0 in 30.9 s; `... --name gh-cred -- bun test ./tests/unit/electron/commands-registry-github.test.ts ./tests/unit/electron/commands-registry-pr.test.ts` -> exit 0 in 10.8 s; `... --name tools-registry -- bun test ./tests/unit/electron/commands-registry-tools.test.ts` -> exit 0 in 0.5 s. The failing set is again unstable between runs and spans three files, which is the same signature as every earlier occurrence. No new evidence about the mechanism. The change under review adds a reviewer fan-out to the build pipeline, a `create_feature_build` command and create-environment dialog work; none of these three files load any of it.

## `live session read paths > denies an oversized blocking hook without broadcasting truncated approval data` (`tests/unit/electron/tmux-session.test.ts:1166`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was in the root/agent-support group.
- **Failure:** `expect(existsSync(pending)).toBe(false)` received `true` at `tmux-session.test.ts:1166` (duration: 606.40 ms). The oversized approval was correctly denied — the emitted hook response carried `permissionDecision: "deny"` — but the pending approval file had not yet been removed when the assertion ran.
- **Suite counts:** 3,741 passed, 1 skipped, 1 failed; 3,743 tests across 181 files in 95.69 s.
- **Isolated rerun:** `bun test tests/unit/electron/tmux-session.test.ts` → 69 passed, 0 failed, in 25.36 s.
- **Follow-up:** Five further complete aggregate runs (`bun run test`) passed, at 94.5 s, 86.6 s, and three more; the failure has not recurred.
- **Hypothesis:** The assertion checks the pending-approval file synchronously right after the deny response is observed, but the file removal is a separate filesystem write on the tmux hook path. Under aggregate contention the removal can land after the response. A recurrence should poll for the file's absence with a bounded diagnostic rather than asserting it in the same tick as the response, and should first confirm that the removal is genuinely ordered after the response rather than racing it in production.


## `ACP bridge > quarantines an unusable state file instead of refusing to start` (`bridges/acp-bridge/src/acp-persistence.test.ts:448`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name review-current-full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the bridges group used two Bun workers.
- **Failure:** `Timed out waiting for ACP state: false` from `acp-test-harness.ts:179`, while `spawnBridge` was waiting for the bridge to become healthy during the test at `acp-persistence.test.ts:448` (duration: 15,087.31 ms).
- **Suite counts:** 2,594 passed, 11 skipped, 1 failed; 2,606 tests across 90 files.
- **Isolated rerun:** `bun run test:logged -- --name acp-persistence-isolated -- bun --cwd=bridges/acp-bridge test src/acp-persistence.test.ts` → passed in 1.5 s.
- **Follow-up:** The bridges group passed alone in 45.3 s, and a fresh aggregate rerun passed in 91.5 s.
- **Hypothesis:** Aggregate bridge-process contention delayed readiness before the state-file quarantine behavior began. The isolated owner passed quickly, so this observation is recorded as a flake rather than a product or test assertion failure; a recurrence should capture the bridge startup timing before changing the quarantine assertions.

## `MultiReviewReviewerTab stop control > reports a refused stop without pretending the reviewer settled` (`apps/web/src/components/review/MultiReviewTab.test.tsx:921`)

- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name fix-full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the web workspace suite used its normal parallel runner.
- **Failure:** Testing Library timed out waiting for `Multi review reviewer not found` after the refused stop; the DOM had already returned to the ordinary running reviewer state (duration: 1,072.24 ms).
- **Suite counts:** web workspace: 5,103 passed, 1 skipped, 1 failed; 5,105 tests across 222 files in 108.69 seconds. The root/agent-support, bridges, and protocol-lockfile groups passed.
- **Isolated rerun:** `bun run test:logged -- --name fix-web-review-tests-rerun -- bun --cwd=apps/web test src/components/review/MultiReviewTab.test.tsx --only-failures` → passed in 5.2 seconds before the aggregate run.
- **Hypothesis:** Aggregate scheduling allowed the transcript poll to finish after the stop rejection and clear the component's shared error state before the assertion observed it.
- **Root cause:** Transcript reads and reviewer actions shared one `error` state. Any successful poll cleared a stop-action failure even though the action had not succeeded.
- **Fix:** Track transcript-read and action failures separately; transcript polling clears only transcript failures, while the action failure remains visible until another action or tab identity change. The one exception is a gone workflow or reviewer, which is terminal for the view and displaces the stale action failure rather than hiding why polling stopped. The regression test now forces a successful refresh after the rejected stop and asserts the action error remains; a sibling test pins the gone-workflow exception.
- **Verification:** The owning component test and the web typecheck were rerun for this change, followed by the aggregate suite. A real-browser pass over the reviewer tab has not been run against this fix and is still outstanding.

## `Pi ACP background discovery > does not re-adopt a settled child's directory for the next unnamed launch` (`bridges/acp-bridge/src/acp-cursor-background.test.ts:1200`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-25
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the bridges group used two Bun workers.
- **Failure:** The lookup for the `cursor-subagent-2` transcript part returned `undefined`, so `toMatchObject({ agentState: "active" })` failed.
- **Suite counts:** complete suite: 14,821 passed, 13 skipped, 2 failed; bridges group: 2,892 passed, 11 skipped, 1 failed.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-cursor-background.test.ts --only-failures` → 34 passed, 0 failed, in 2.67 seconds.
- **Hypothesis:** The test confirms `working` activity with five immediate probes and then reads the transcript once. Child discovery and transcript projection are separate asynchronous updates, so aggregate bridge contention can expose `working` before the new child card has been projected. A recurrence should poll for the `cursor-subagent-2` part with the existing bounded diagnostic rather than weakening its required `active` state.

## 2026-08-16 resolution sweep

The remaining open entries were reconciled against their current owning files
after the large test-module split and resolved in `fix-flaky-tests-3`. Historical
observations below remain unchanged; the rows here provide the root cause, fix,
and verification for entries whose status links back to this sweep.

| Entries | Root cause | Fix | Verification |
| --- | --- | --- | --- |
| ACP bridge health failures, including the oversized-response and concurrent-turn cases | A fresh bridge used the same 5-second deadline as an ordinary state poll. Aggregate child-process contention could exhaust readiness before the behavior under test began. | Give startup its own 15-second readiness deadline and retain a tighter 5-second state-poll diagnostic inside a 30-second outer budget. | The ACP owner passed in the concurrent bridge-owner run and in the complete aggregate suite. |
| All tmux lifecycle, MCP-config, hook, launch, and cleanup clusters | Real shim and tmux processes shared Bun's 5-second outer budget and a 2-second internal poll. An outer timeout interrupted fixture cleanup, causing the later missing-shim and missing-log cascade. | Set a 30-second file budget and a 10-second condition deadline in the shared post-split tmux harness, so cleanup completes and a genuine stall still names its condition. | The current `tmux-commands.test.ts` owner passed inside the 70.7-second four-worker root-owner contention run and the complete aggregate suite. |
| Standalone backend shutdown and Tailscale Serve lifecycle entries | Tests combine real backend startup, child-tree shutdown, and sometimes a second startup. The startup loop could also remain blocked in `reader.read()` past its nominal deadline. | Race the startup read against a 20-second deadline so the named diagnostic no longer depends on the child closing stdout, escalate `SIGTERM` to `SIGKILL` after a 2-second grace, bound the stderr drain used for the message, and add a 30-second file budget plus a 60-second budget for the two-lifecycle Serve case. | The built standalone owner passed with two workers; backend typecheck and the complete aggregate suite passed. |
| Packaged CLI backend lifecycle | The test's real readiness and graceful-exit deadlines could outlive Bun's 5-second outer budget under workspace contention. | Keep the diagnostic 20-second readiness and 10-second exit deadlines inside a 40-second file budget. | The package build/test passed in 3.8 seconds and the complete workspace aggregate passed. |
| Command-registry Git fixture, deduplicated/admitted container starts, and process-launch coverage | The former monolithic command file performed real Git/Docker/launcher work against 3-5 second wall-clock budgets. The split reduced contention, but the shared condition deadline and individual outer budgets were still shorter than the supported process window. | Raise the shared condition deadline to 10 seconds and its outer budget to 30 seconds; give the Git and launcher cases explicit bounded budgets. Because the raised condition deadline now exceeds Bun's 5-second default, every remaining case that waits on the shared helper without its own budget was given one, so the helper's named diagnostic still wins the race. | Current split owners passed together under four-worker contention in 70.7 seconds and in the complete aggregate suite. |
| Download and install shell-script entries | Real shell/shim processes were killed by Bun's outer timeout, producing downstream exit code 143; one install assertion also spawned `ls` only to inspect a directory. | Use 30-second downloader and 20-second installer budgets. The artifact-sanitizer directory assertion now uses `readdir` directly, removing its unrelated child process. | Root owners passed under contention; the sanitizer staging case passed 30/30 repetitions; the complete aggregate suite passed. |
| ActionBar long-press unmount entries | The assertion queried immediately after sleeping only 25 ms beyond the production long-press timer, before React was guaranteed to commit the dialog. | Wait for the accessible dialog with a bounded 10-second UI wait before unmounting, within a 20-second test budget. | The exact case passed 10/10 repetitions, the complete owner passed, web typecheck passed, and the aggregate suite passed. |
| Mobile drawer focus-restoration entries | Each case mounts the complete Radix mobile shell, then crosses an asynchronous dismissal/focus boundary inside Bun's 5-second outer budget. | Preserve the dismissal and focus assertions but give each close-and-restore case its own 20-second budget. | The selected mobile, queue, and resync cases passed 10/10 repetitions under concurrent stress; the owner and aggregate suite passed. |
| Prompt-queue live lease recovery | The test stopped polling as soon as durable queue recovery was visible, even though the resource-change listener is a distinct asynchronous observation. | Poll the actual conjunction: recovered queue state and the expected listener announcement. | The exact case passed 20/20 repetitions and the backend owner and aggregate suite passed. |
| UpdateCoalescer dynamic interval | A fixed 5 ms negative assertion could run after the configured 35 ms interval when the worker was descheduled, observing the legitimate fourth publish early. | Assert the observable cadence between the third and fourth publication instead of racing a short sleep against the timer, timestamping each publication with `performance.now()` so the bound is measured on the same monotonic clock the timer uses. | The exact case passed 30/30 repetitions and the bridge owner and aggregate suite passed. |
| Shared-thread generated title persistence | The test used a fixed delay without waiting for title generation to start or for both persistence writes to finish. Repetition exposed that the deferred resolver itself could be called before assignment. The post-split owner also prevents unrelated runtime files from sharing its harness state. | Wait for resolver installation, then poll both persisted records for the generated title and source; the shared wait helper now accepts asynchronous predicates, covered directly by `app-server-runtime-wait-helpers.test.ts` so a helper that stops awaiting its predicate fails there rather than silently degrading every caller. | Ten fresh-process repetitions passed, as did the bridge-owner run and the aggregate suite. |
| Authoritative collection resync after backend restart | Fixed 80 ms sleeps were treated as completion signals for initial hydration and reconnect reconciliation. | Poll the actual project/environment collections and manifest generation boundary with a bounded diagnostic, then settle once past the reconciliation window so an uncoalesced third manifest load is still counted by the exact-count assertion rather than arriving after the test passes. | The owner passed, and the selected resync case passed 10/10 concurrent repetitions; web typecheck and the aggregate suite passed. |
| Structured Claude usage timeout | Bun schedules timers on a monotonic clock, while the lower-bound assertion measured `Date.now()`. Wall-clock adjustment made a correct 1-second timeout appear 5 ms too early. | Measure the elapsed interval with `performance.now()` while retaining both lower and upper bounds. | The exact one-second timeout case passed 5/5 concurrent repetitions and the bridge owner and aggregate suite passed. |
| QueuedPromptsDialog action ordering | Polling around synchronous mock callbacks added scheduler windows unrelated to the move/remove behavior and left the original aggregate failure without a stable matcher. | Flush each click's async React action with `act`, then assert exact call order and identifiers directly. | The selected case passed 10/10 concurrent repetitions, the owner passed, and web typecheck and the aggregate suite passed. |
| NativeMessage MIME previews and FilesPanel confirm/retry | Both multi-transition component cases exhausted only the generic outer budget under severe renderer contention; the NativeMessage Escape-listener race was already fixed separately. | Retain all UI assertions and give each integration-style component case an explicit 20-second budget. | Both owners passed together in the four-worker root contention run and in the complete aggregate suite. |
| Runtime-environment refresh and Codex title-generation failure matrix | Each case deliberately launches shell subprocesses; the isolated functional paths were fast but aggregate process startup could consume the generic outer budget. | Give the runtime helper 15 seconds and the four-mode title failure matrix 15 seconds without changing their product assertions. | Both bridge owners passed concurrently and in the aggregate suite. |
| EnvironmentSettingsDialog duplicate tabs | A document-wide role query included tabs leaked elsewhere in the shared happy-dom document. | The current test scopes the exact tab-set assertion to the dialog's labelled `Agent extensions` tablist. | The root owner contention run and aggregate suite passed. |
| Artifact-sanitizer staging | The test used an external `ls` subprocess solely to read one directory, and interpreted empty stdout as an empty basename under aggregate process pressure. | Use `readdir` and assert the exact surviving entry without another process boundary. | The exact case passed 30/30 repetitions and the root owner run passed. |

The verification commands were all run through `test:logged`. The first complete
post-fix aggregate passed in 145.1 seconds; a second aggregate was then run after
the title-start and artifact-directory stress findings were incorporated and
passed in 94.7 seconds.

Review follow-up, same branch. The standalone startup deadline was verified
directly by shortening `BACKEND_READY_TIMEOUT_MS` to 150 ms against a backend
that had not yet printed its ready line: the helper failed at 155 ms with
`Timed out waiting for standalone backend after 150ms`, proving the diagnostic
no longer waits for the child to close stdout. The new
`app-server-runtime-wait-helpers.test.ts` was verified against the pre-fix
helper body (`while (!predicate())`), where its three asynchronous cases fail and
the two synchronous cases still pass; all five pass against the current helper.
The three web, codex-bridge, and electron owners passed individually, the three
typechecks passed, and a third complete aggregate passed in 162.9 seconds.

Second review follow-up, same branch. The standalone ready helper now kills
only on the timeout path, clears the deadline before reading the auth file, and
is covered by `standalone-ready.test.ts` (named timeout without waiting for
stdout to close, SIGTERM-to-SIGKILL escalation, bounded stderr drain,
abandoned-read swallowing, slow auth-file success without a kill, and a missing
token that fails immediately). The authoritative resync case fires the boot
connect before restart work so it stays inside `BOOT_ANNOUNCE_COALESCE_MS`,
asserts that coalesced load count, then settles for that window after the
reconnect.

## Renamed owning files

Every entry below records the file name, line number, command, and counts
**exactly as observed at the time of the run**. Those are evidence and are never
rewritten, because a rewritten stack location or a rewritten command no longer
identifies anything that was actually executed.

Several owning files were split into narrower ones on 2026-08-16
(`refactor(tests): split oversized test modules`). Historical entries still name
the pre-split file; use this table to find the file that owns those tests today.
The recorded line numbers refer to the pre-split file and can be resolved
against the commit named in the entry, or against `main` before that split.

| Historical file | Current owner |
| --- | --- |
| `apps/backend/src/core/build-pipeline-service.test.ts` | `apps/backend/src/core/build-pipeline-service-*.test.ts` |
| `apps/backend/src/core/native-agent-service.test.ts` | `apps/backend/src/core/native-agent-service-*.test.ts` |
| `apps/web/src/components/terminal/TerminalContainer.test.tsx` | `apps/web/src/components/terminal/TerminalContainer*.test.tsx` |
| `apps/web/src/lib/opencode-client.test.ts` | `apps/web/src/lib/opencode-*.test.ts` |
| `bridges/acp-bridge/src/index.test.ts` | `bridges/acp-bridge/src/acp-*.test.ts` |
| `bridges/claude-bridge/src/services/session-manager.test.ts` | `bridges/claude-bridge/src/services/session-manager-*.test.ts` |
| `bridges/codex-bridge/src/app-server-runtime.test.ts` | `bridges/codex-bridge/src/app-server-runtime-*.test.ts` |
| `tests/unit/components/ClaudeTmuxChatTab.test.tsx` | `tests/unit/components/ClaudeTmuxChatTab.test.tsx` and `ClaudeTmuxChatTab.parts.test.tsx` |
| `tests/unit/electron/commands.test.ts` | `tests/unit/electron/commands-*.test.ts` |
| `tests/unit/electron/gateway.test.ts` | `tests/unit/electron/gateway-*.test.ts` |
| `tests/unit/electron/tmux-backend.test.ts` | `tests/unit/electron/tmux-*.test.ts` |

To rerun one of these in isolation today, substitute the current owner into the
entry's recorded command — for example
`bun test ./bridges/acp-bridge/src/acp-*.test.ts` in place of
`bun test ./bridges/acp-bridge/src/index.test.ts`. A new observation should be
recorded against the file that actually ran, not against the historical name.

## `ACP bridge > bounds one oversized response without failing the session` (`bridges/acp-bridge/src/index.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name fixes-full-tests -- bun run test`
  at `88b56425006c8664d2c1d669af0203ef196df273`.
- **Worker configuration:** the bridge group used two Bun workers while the
  workspace, root/agent-support, and protocol-lockfile groups ran concurrently.
- **Failure:** `spawnBridge` exhausted its 5,000 ms health wait before the test
  could begin its oversized-response assertions: `Timed out waiting for ACP
  state: false` at `index.test.ts:113`, reached from `spawnBridge` at line 158.
  The failing case took 5,011.22 ms and reported no product assertion mismatch.
- **Suite counts:** bridges group: 2,537 passed, 11 skipped, 1 failed, 8,460
  assertions across 70 files in 51.36 seconds. The workspace, root/agent-support,
  and protocol-lockfile groups passed.
- **Isolated rerun:** `bun run test:logged -- --name isolate-acp-oversized-response -- bun test ./bridges/acp-bridge/src/index.test.ts --test-name-pattern "bounds one oversized response without failing the session" --only-failures`
  passed in 0.3 seconds. The complete owning file had also passed in 34.2 seconds
  immediately before the aggregate run.
- **Hypothesis:** aggregate process-start contention delayed the bridge health
  endpoint beyond `waitFor`'s fixed five-second budget. This is the same startup
  boundary as the resolved Cursor child-settlement flake below, but now occurred
  before a different case. The product behavior and the test's oversized-frame
  assertions both pass when the bridge can start without aggregate contention;
  a readiness signal or a startup-specific budget should be evaluated before
  changing those assertions.

## `ACP bridge > settles Cursor's in-process child as finished` (`bridges/acp-bridge/src/index.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** bridges group used two workers while workspace, root,
  and protocol-lockfile groups ran concurrently.
- **Failure:** the test exceeded Bun's default 5,000 ms timeout (`5000.79 ms`).
  Bun then killed the spawned bridge (`killed 1 dangling process`), and the
  in-flight `waitFor` fetch failed as an unhandled `ConnectionRefused` against
  `/session/:id`.
- **Suite counts:** bridges group: 2,503 passed, 11 skipped, 1 failed, 1 error
  across 70 files.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/index.test.ts -t "settles Cursor's in-process child"`
  → passed in 0.3 s.
- **Root cause:** `spawnBridge` already waits up to 5 s for health, then this
  case runs two more 5 s `waitFor` polls, all inside Bun's 5 s default test
  budget. Under aggregate spawn contention the health wait consumed the budget
  before the child could settle. `waitFor` also rethrew connection errors
  immediately, so the killed child became a second unhandled error.
- **Fix:** retry `ConnectionRefused` inside `waitFor` until the deadline so a
  refused connection becomes a bounded wait diagnostic that names the retried
  code, and raise the per-test budget to 20 s. The budget is set once for the
  whole file with `jest.setTimeout`, not on the two tests that happened to fail
  first: the root cause is structural — 138 of the file's `spawnBridge` calls
  are followed by at least one further `waitFor` — so a per-test timeout would
  only have moved the flake to the next case to lose the race. `waitFor`'s own
  default stays at 5 s, deliberately below the test budget, so its diagnostic
  wins against Bun's generic timeout instead of being pre-empted by it.
- **Verification:** focused settle tests passed in 0.3 s, the owning file passed
  in 29.2 s, and the complete concurrent suite passed in 138.5 s with no
  failures. The `waitFor` retry policy itself now has direct unit coverage in
  the same file (`describe("waitFor")`), including the timeout diagnostic.

## `ActionBar workflow tabs > clears active long-press click suppression when the action bar unmounts` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-16
- **Original command:**
  `bun run test:logged -- --name web-pkg-tests -- bun --cwd=apps/web test --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers, while a *separate* worktree on this
  host was running a full aggregate `bun run test` concurrently. Host contention
  was therefore well above a normal single-suite run.
- **Failure:** `getElementError` from `tests/bounded-test-diagnostics.ts:28`,
  raised at `ActionBar.test.tsx:2989` — the
  `screen.getByRole("dialog", { name: "Configure code review" })` assertion found
  no dialog. The case fires a touch `pointerDown` on the Code review button, then
  waits a bare `setTimeout` of 575 ms for the long-press threshold to elapse
  before asserting the dialog opened.
- **Suite counts:** `5002 pass, 1 fail. Ran 5004 tests across 215 files. [40.04s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
  → 166 passed, 0 failed in 15.67 s. The same aggregate command then passed three
  consecutive times (40.3 s, 49.1 s, 50.8 s).
- **Hypothesis:** the fixed 575 ms sleep is the whole margin over the component's
  long-press threshold, so it is a race against the wall clock rather than against
  application state. Under contention the timer fires late, or the React commit
  that mounts the dialog lands after the sleep resolves, and the immediate
  `getByRole` misses it. A `waitFor` around the dialog assertion would remove the
  race without weakening it — the case's real subject is the `createTabMock`
  assertion after `unmount()`, not the dialog's arrival latency. Nothing in the
  failing path touches agent skills, extension discovery, or the ACP bridge, which
  are the only areas the commit that observed this changed.

## `ACP bridge > settles Cursor's in-process child as failed` (`bridges/acp-bridge/src/index.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test`
- **Worker configuration:** bridges group used two workers while the workspace,
  root, and protocol-lockfile groups ran concurrently.
- **Failure:** the second `waitFor` in the case — the one polling `/session/:id`
  for the sub-agent part to reach `agentState: "failed"` — exhausted its own
  5,000 ms deadline (`5095.93 ms`) and threw the bounded diagnostic
  `Timed out waiting for ACP state: {…"status":"idle"…}` from
  `index.test.ts:113`, raised at `index.test.ts:1721`. The snapshot in the
  diagnostic shows the session already idle with the sub-agent part still
  `agentState: "active"`.
- **Suite counts:** bridges group: 2,540 passed, 11 skipped, 1 failed. The root
  and agent-support group failed the same run for two unrelated reasons
  (`test-diagnostic-bounds` and `CreateEnvironmentFlowDialog`), both of which
  reproduce on `main`.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/index.test.ts` → passed in
  31.8 s, and again in 31.9 s after the usage changes in the same commit.
- **Relationship to the resolved entry above:** this is the sibling case of
  `…as finished` in the same `for` loop, and the earlier fix held — Bun's 20 s
  per-test budget was not exceeded and the retry policy produced a useful
  diagnostic instead of an unhandled `ConnectionRefused`. What expired this time
  is `waitFor`'s own 5 s default, so the previous root cause (the health wait
  eating the whole test budget) is not sufficient to explain it.
- **Hypothesis:** contention, not a product regression. The case starts a
  background sub-agent, then a second prompt whose terminal notification must
  land within 5 s; under aggregate load the spawned bridge and its fake agent
  share CPU with three other groups. Nothing in the failing path touches usage
  accounting, which is the only bridge behaviour the commit that observed this
  changed. A recurrence should capture whether the background child had settled
  in the agent (the fake agent's own write ordering) or only the bridge's
  observation of it was late, before raising the wait deadline — a longer
  deadline would hide an ordering bug as easily as it would absorb contention.
- **Recurrence (2026-08-16):** The same aggregate command reproduced the sibling
  `FINISHCURSORTASK` case: 2,558 passed, 11 skipped, and 1 failed in the bridges
  group. The diagnostic snapshot had `revision: 4`, only the initial
  `BACKGROUNDSUBAGENT` turn, `status: "idle"`, and an active child; no second
  user message or terminal frame had been recorded. The owning file passed in
  38.5 s.
- **Root cause:** The test waited for `/activity` to become `working`, but that
  endpoint intentionally reports active background children as working even
  after their parent turn is complete. Under aggregate scheduling the first
  prompt was still running when the test sent the follow-up, so the bridge
  correctly returned `409 Session is already running`; the test ignored that
  response and later misdiagnosed the still-active child as a missed terminal
  notification. The same race affected every sibling case in the loop.
- **Fix:** Wait for the authoritative session snapshot to be `idle` while the
  child part remains `active` before sending each follow-up, and assert that
  every follow-up returns `202`. This preserves the intended cross-turn child
  lifecycle without extending a deadline or weakening the settlement checks.
- **Verification:** `bun run test:logged -- --name acp-index-sync-fixed -- bun test
  ./bridges/acp-bridge/src/index.test.ts` passed the owning file in 38.5 s, and
  the bridge group passed in 38.9 s after the synchronization fix. The final
  `bun run test:logged -- --name full-suite-final -- bun run test` passed all
  four concurrent groups in 99.2 s.

## Test bootstrap mock-registration cascade (`apps/web` and root renderer tests)

- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** workspace web tests used two workers and the root
  group used four workers; independent workspace, root, bridge, and protocol
  groups ran concurrently.
- **Failure:** Hundreds of otherwise unrelated renderer tests reported that
  central native-backend functions were no longer Bun mocks (for example,
  `nativeInvokeMock.mockClear is not a function`) or observed shared DOM/mock
  state. One recorded root result was 3,338 passed, 1 skipped, and 345 failed.
- **Isolated rerun:** The affected `AgentInfoButton.test.tsx`,
  `NativeMessage.test.tsx`, `GlobalSettings.test.tsx`,
  `TerminalComposeBar.test.tsx`, `HierarchicalSidebar.test.tsx`,
  `useNativeComposeBarPaste.test.tsx`, `useAgentState.test.tsx`,
  `usePrMonitorService.test.tsx`, `useProjects.test.ts`, and
  `terminal-paste.test.ts` files all passed when run in their own processes.
- **Hypothesis:** Confirmed by the fix below; this was bootstrap ordering, not
  independent product regressions.
- **Root cause:** `tests/setup.ts` used a top-level dynamic import after Happy
  DOM registration. Bun could begin test-module evaluation before the
  post-`await` central `mock.module()` registrations completed.
- **Fix:** Happy DOM registration moved into the earlier synchronous
  `tests/register-dom.ts` preload. `tests/setup.ts` and all central mocks remain
  synchronous while Testing Library still evaluates after a document exists.
- **Verification:** The affected focused files passed, a six-worker root stress
  run passed in 81.7 seconds, and the complete concurrent suite passed in 84.7
  seconds with no failures.

## `scripts/test-all.ts > the non-iOS groups run concurrently, not one after another` (`tests/unit/test-all.test.ts`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** root group at four workers while the other aggregate
  groups ran concurrently.
- **Failure:** Expected the root group to have started, but `started` was still
  empty after the test's fixed five-millisecond delay (10.59 ms).
- **Suite counts:** Root group: 3,682 passed, 1 skipped, 1 failed across 146
  files; other root tests passed.
- **Isolated rerun:** `bun test ./tests/unit/test-all.test.ts --only-failures`
  passed.
- **Root cause:** Artifact-retention pruning now precedes group construction.
  On a busy host it can legitimately take longer than the test's arbitrary
  five-millisecond scheduling assumption.
- **Fix:** Poll the observable group-start boundary for up to one second. A
  genuinely sequential implementation still cannot pass because the first
  group remains deliberately gated.
- **Verification:** Focused runner tests and the complete concurrent suite pass.
- **Recurrence (2026-08-17, `claude-task-layout`):** failed again at 1008.70 ms in a
  full `bun run test`, which is the one-second poll the fix above installed rather
  than the original five-millisecond assumption — so the observable group-start
  boundary took longer than a second to appear. The same run also hit the
  5000 ms-deadline cluster documented above and took 229.6 s against ~137 s for
  the identical command minutes earlier on the same tree, so the host was
  materially slower throughout. `bun test tests/unit/test-all.test.ts` passed
  alone immediately afterwards (32 passed, exit 0).
- **Next step:** the fix chose a bound where it needs a signal. Polling longer
  would move the same threshold again; what the test actually wants is to wait on
  the group-start boundary without a deadline and let the suite-level timeout be
  the only limit, or to assert concurrency from the recorded start/end ordering
  after the run rather than by sampling it live. Do not simply raise the second.

## `Electron tmux backend command registration` — three lifecycle tests (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Affected tests:** `serializes stop behind an in-flight start so no tmux session is orphaned` (2,010.43 ms), `keeps per-environment hook state under the shared runtime root and removes it on stop` (154.62 ms), and `environment teardown kills live sessions, restores settings and removes the runtime root` (1,469.94 ms).
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-2.log`
- **Worker configuration:** the root and agent-support group ran `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel` while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** all three failed as `error: timed out waiting for condition` from the file's own `waitFor` helper (`tmux-backend.test.ts:830`), reached through `withFakeTmuxRuntime`. The surrounding output also shows the fake runtime's `claude` shim missing during a probe: `ENOENT ... /T/ork-tmux-runtime-rXh3aJ/bin/claude`.
- **Suite counts:** root and agent-support group: 3 failed; the workspace, bridge, and protocol-lockfile groups all passed in the same run.
- **Isolated rerun:** `bun test tests/unit/electron/tmux-backend.test.ts` -> 173 passed, 0 failed.
- **Pre-existing:** unrelated to the OpenCode provider-filter change, which touches no tmux, PTY, or runtime-root code. These three did not fail in the immediately preceding full run of the same tree, which failed a different pair of tests instead; the group's failures move between runs.
- **Hypothesis:** the three failures share `withFakeTmuxRuntime`, which builds a temporary runtime root with executable shims and waits on real spawn/kill transitions. The `ENOENT` on the shim path suggests the fake runtime was torn down or not fully written while another test in the same worker was still probing it, so the awaited condition never became true. Whether the shared temp-root lifecycle is worker-safe should be established before any timeout is raised.

## `Electron tmux backend command registration` aggregate launch/cleanup failures (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group ran `bun test ./tests ./e2e/agent-testing/artifact-sanitizer.test.ts ./test-fixtures/agent-project/server.test.ts --parallel=4` while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** Five cases failed in one stateful owning file: `writes an owner-only agent MCP config and includes it in a local Claude launch` timed out after 5,000 ms (5,002.60 ms); `does not create an agent MCP config when Claude lacks the launch flag` then requested a connection the fixture declares unreachable (344.24 ms); `serializes stop behind an in-flight start so no tmux session is orphaned` timed out waiting for its condition (2,006.39 ms); `keeps per-environment hook state under the shared runtime root and removes it on stop` reached a missing fake Claude executable (621.98 ms); and `environment teardown kills live sessions, restores settings and removes the runtime root` found no fake tmux log (1,675.57 ms).
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors. The other two root failures are recorded separately below.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts 2>&1 | tee /tmp/orkestrator-tmux-backend-isolated-acp-image-fixes.log` -> 173 passed, 0 failed, 615 assertions in 74.19 seconds; all five affected cases passed.
- **Recurrence (terminal-session recovery coverage, 2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-c4ce823f-full-tests.log` at `c4ce823fb218e0f858115c0e0ada81203998c10a` ran this file in the four-worker root group while the workspace, bridge, and protocol-lockfile groups ran concurrently. `serializes stop behind an in-flight start so no tmux session is orphaned` timed out in its internal condition wait (2,035.65 ms); `keeps per-environment hook state under the shared runtime root and removes it on stop` lost the temporary fake Claude/tmux runtime (113.52 ms); and `environment teardown kills live sessions, restores settings and removes the runtime root` could not read the fake tmux log (1,334.79 ms). The root group reported 3,649 total, 3,645 passed, 1 skipped, 3 failed, and 1 between-test error. The immediate isolated rerun, `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts --parallel 2>&1 | tee /tmp/orkestrator-c4ce823f-tmux-backend-isolated.log`, passed all 173 tests with 615 assertions in 76.26 seconds; the three affected cases passed in 480.13 ms, 352.60 ms, and 353.19 ms.
- **Recurrence (2026-08-15):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log` ran the root group at four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently. The same five cases failed: the first exhausted Bun's 5,000 ms budget, and the later cases reported the same missing fake executable, forbidden connection, wait timeout, and missing fixture artifacts seen after an interrupted cleanup. The root group reported 3,657 passed, 1 skipped, 6 failed, and 3 between-test errors; its sixth failure is recorded separately below.
- **Recurrence isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts --parallel 2>&1 | tee /tmp/orkestrator-fix-tmux-backend-isolated.log` -> 173 passed, 0 failed, 615 assertions in 63.02 seconds; all five affected cases passed.
- **Hypothesis:** The first failure is a bare five-second timeout in a process-heavy fixture while four aggregate groups compete for process startup. Because the file shares fake runtime/module state across its lifecycle tests, interruption of that first case's cleanup plausibly caused the four later missing-runtime and ordering failures; the complete file rebuilt and cleaned every fixture successfully in a fresh isolated process. No product code touched by the ACP image change appears in these stacks.
- **Recurrence (ACP `waitFor` coverage and engine docs, 2026-08-15):** `bun run test:logged -- --name full-suite-3 -- bun run test` ran the root group at six Bun workers while the workspace, bridges, and protocol-lockfile groups ran concurrently; those three groups all passed. `serializes stop behind an in-flight start so no tmux session is orphaned` failed at 2,026.74 ms, this time with a functional error rather than a bare timeout: `Installed claude CLI does not support --session-id`, thrown from `startAfterHooksInstalled` (`apps/backend/src/core/tmux.ts:2013`) after the fake runtime's `claude --help` probe returned help text without the flag. `keeps per-environment hook state under the shared runtime root and removes it on stop` then failed in 0.42 ms. The root group reported 3,696 passed, 1 skipped, 3 failed across 147 files in 223.68 s; the third failure is recorded separately below. The same command had passed completely on the immediately preceding run, and the isolated rerun `bun test tests/unit/electron/tmux-backend.test.ts` -> 173 passed, 0 failed, 615 assertions in 62.95 s.
- **Note on the probe variant:** the `--session-id` message is a new surface for this cluster and is worth distinguishing from the earlier missing-executable failures. It means the fake `claude` shim was found and executed but produced help output that did not contain the flag, which is consistent with a truncated or empty probe result under contention rather than with a missing fixture.
- **Recurrence (ACP usage replay guard, 2026-08-16):** `bun run test:logged -- --name full-suite2 -- bun run test` failed the same pair — `serializes stop behind an in-flight start so no tmux session is orphaned` (2,025.50 ms) and `keeps per-environment hook state under the shared runtime root and removes it on stop` (61.70 ms). Root group: 3,695 passed, 1 skip, 5 fail; the workspace and protocol-lockfile groups passed. Isolated rerun `bun test tests/unit/electron/tmux-backend.test.ts` -> passed in 99.4 s. The same command had passed this file completely on the immediately preceding run of the same tree, which failed a different cluster instead. Contention was higher than usual: the host had run three full aggregate suites plus several owning-file reruns back to back.
- **Recurrence (shared native-agent capability table, 2026-08-16):** `bun run test:logged -- --name full-suite -- bun run test` at `8136e45aea7db854a29338e4ce0b78513668e3ae` failed only `environment teardown kills live sessions, restores settings and removes the runtime root` (2,226.10 ms), again on the missing fake tmux log: `ENOENT ... /T/ork-tmux-runtime-kIy7Ad/tmux.log` at `tmux-backend.test.ts:1449`. The same command re-run immediately against the identical tree did not fail this case at all — the only failures in the second run were the two deterministic pre-existing ones recorded in this file's separate entries — so this is the same contention-driven cluster rather than a new defect. No tmux, PTY, or runtime-root code is touched by that commit, which changes only the native-agent capability table, the queued fast-mode field lookup, and their tests.

## `standalone backend service` process-shutdown timeouts (`apps/backend/tests/standalone.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Affected tests:** `drains an active local server process tree before exiting` and `exits without a leftover listener when environment-managed Serve setup fails`.
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the backend workspace ran `bun test src tests --parallel=2` while the web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** both cases exhausted Bun's 5,000 ms per-test budget, at 5,001.05 ms and 5,000.08 ms respectively. Bun also reported two between-test errors after killing the timed-out child processes.
- **Suite counts:** backend package: 1,705 passed, 2 failed, and 2 between-test errors across 55 files.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/standalone.test.ts --parallel 2>&1 | tee /tmp/orkestrator-fix-backend-standalone-isolated.log` from `apps/backend` -> 8 passed, 0 failed, 36 assertions in 15.40 seconds; the two affected cases passed in 1,928.31 ms and 1,701.20 ms.
- **Earlier occurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-c4ce823f-full-tests.log` at `c4ce823fb218e0f858115c0e0ada81203998c10a` ran the backend workspace as `bun test src tests --parallel=2` alongside the other aggregate groups. `exits without a leftover listener when environment-managed Serve setup fails` exceeded Bun's 5,000 ms outer budget (5,001.28 ms), after which the runner killed three dangling processes and the following Serve rejection case produced a between-test assertion because its child stderr was empty. The backend package reported 1,696 total, 1,695 passed, 1 failed, and 1 between-test error. The immediate isolated rerun, `set -o pipefail; bun test ./tests/standalone.test.ts --parallel 2>&1 | tee /tmp/orkestrator-c4ce823f-standalone-isolated.log`, passed all 8 tests with 36 assertions in 21.05 seconds; the affected case passed in 2,188.24 ms.
- **Hypothesis:** both tests start and stop real child-process trees and remained well below their outer budget without the other three validation groups competing for process startup. The aggregate log contains no failed functional assertion before either budget expired, and the reviewed repository-settings change does not touch backend lifecycle code.

## `Electron backend command registry > deterministically generates refs, diff, Git-object contents, hashes, and validation evidence` (`tests/unit/electron/commands.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran with four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** the Git fixture test exhausted Bun's 5,000 ms budget at 5,017.86 ms. Bun then killed two dangling child processes and reported a between-test `git cat-file` command error from the interrupted fixture.
- **Suite counts:** root and agent-support group: 3,657 passed, 1 skipped, 6 failed, and 3 between-test errors across 145 files; the other five failures are the tmux cluster recorded above.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts --parallel 2>&1 | tee /tmp/orkestrator-fix-commands-isolated.log` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 73.77 seconds; the target passed in 1,787.61 ms.
- **Hypothesis:** this case performs several real Git subprocess operations inside one five-second outer budget. It completed in under two seconds when isolated, while the aggregate run was simultaneously timing out other process-heavy backend and tmux tests; no assertion mismatch was observed before the timeout.

## `Electron backend command registry > deduplicates concurrent background starts for one environment` (`tests/unit/electron/commands.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `bun run test:logged -- --name full-suite-3 -- bun run test`
- **Worker configuration:** the root and agent-support group ran at six Bun workers while the workspace, bridges, and protocol-lockfile groups ran concurrently; those three groups passed.
- **Failure:** `error: Timed out waiting for deduplicated background start to finish`, raised by the file's own `waitForCondition` helper (`commands.test.ts` line 1139) after 3,004.38 ms, reached through the nested `withFakeGh` -> `withFakeDocker` fixtures at `commands.test.ts:4358`. The helper polls every 5 ms against its own three-second budget, so this expired inside the fixture rather than against Bun's outer per-test budget.
- **Suite counts:** root and agent-support group: 3,696 passed, 1 skipped, 3 failed, 16,678 assertions across 147 files in 223.68 s. The other two failures are the tmux cluster recorded above.
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 405 passed, 1 skipped, 0 failed, 2,411 assertions in 65.78 s; the affected case passed.
- **Hypothesis:** the case asserts that two concurrent starts collapse into one by waiting for a real fake-Docker child to finish inside a three-second budget. The same aggregate run was simultaneously timing out two process-heavy tmux cases, so process-startup contention is the most likely cause; no assertion mismatch was reported before the wait expired. Distinct from the `deterministically generates refs, diff, Git-object contents, hashes, and validation evidence` entry above, which is a different test in the same file and expired against Bun's outer budget instead.
- **Recurrence (ACP usage replay guard, 2026-08-16):** `bun run test:logged -- --name full-suite2 -- bun run test` failed it again at 3,009.54 ms — the same three-second `waitForCondition` budget, in the same run that failed the tmux pair above. Root group: 3,695 passed, 1 skip, 5 fail. Isolated rerun `bun test tests/unit/electron/commands.test.ts` -> passed in 71.6 s. The pairing with the tmux cluster has now held across three separate aggregate runs, which continues to point at shared process-startup contention rather than at anything in this file.

## `download-claude.sh > downloads, extracts, probes, and cleans up on Darwin/x86_64` (`tests/unit/download-scripts.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 15000ms` (duration: 15,772.04 ms).
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/download-scripts.test.ts 2>&1 | tee /tmp/orkestrator-download-scripts-isolated-acp-image-fixes.log` -> 33 passed, 0 failed, 158 assertions in 27.11 seconds; the affected case passed in 3,951.34 ms.
- **Hypothesis:** The case launches a shell download/extract/probe harness and exceeded only its outer wall-clock budget during a run with several other process-heavy groups. Its functional assertions completed more than eleven seconds inside that budget in isolation; no download or toolchain code changed in this work.

## `NativeMessage > derives image mime types from the container attachment extension` (`tests/unit/components/NativeMessage.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The asynchronous two-preview case failed after 13,950.37 ms. Bun's retained failure payload expanded the React fiber/DOM object rather than preserving a concise matcher message.
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/components/NativeMessage.test.tsx 2>&1 | tee /tmp/orkestrator-native-message-isolated-acp-image-fixes.log` -> 93 passed, 0 failed, 296 assertions in 1.81 seconds; the affected case passed in 43.01 ms.
- **Hypothesis:** The case opens one asynchronous image preview, closes it through React, then opens a second. The same transitions completed immediately in a clean process, while the aggregate run was already experiencing severe process and renderer scheduling contention. The reviewed ACP fix changes bridge URL creation only; this root-level renderer test uses fixed `/workspace/...` paths and did not execute that code.

## `NativeMessage > opens local image previews and closes the overlay with Escape` (`tests/unit/components/NativeMessage.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`
- **Worker configuration:** the root and agent-support group ran with six Bun
  workers while the workspace, bridge, and protocol-lockfile groups ran
  concurrently.
- **Failure:** the Escape assertion failed only in the aggregate run after the
  image had opened; the root group reported 3,697 passed, 1 skipped, and 3
  failed across 147 files. The owning file and the six-worker root group both
  passed when rerun alone.
- **Isolated rerun:** `bun run test:logged -- --name native-message-fixed -- bun
  test ./tests/unit/components/NativeMessage.test.tsx` passed in 2.7 s; the
  six-worker root group passed 3,701 tests in 122.7 s after the fix.
- **Root cause:** The overlay installed its Escape listener in a passive
  `useEffect`, leaving a scheduler-dependent window after the overlay became
  visible in which the test's key event could arrive before the listener was
  attached. The file-part close callback was also recreated during renders.
- **Fix:** Install the overlay's keyboard listener in `useLayoutEffect` and use
  a stable close callback for the overlay. Escape is now wired before the
  visible overlay can be interacted with, including under aggregate renderer
  load.
- **Verification:** The focused file and the six-worker root group passed. The
  final `bun run test:logged -- --name full-suite-final -- bun run test` passed
  all four concurrent groups in 99.2 s.

## `Codex session titles > rejects spawn, nonzero, signal, and invalid-output failures and cleans temporary state` (`bridges/codex-bridge/src/session-titles.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel=2` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 5000ms` (duration: 6,205.38 ms).
- **Suite counts:** Bridge group: 2,394 total, 2,382 passed, 11 skipped, and 1 failed.
- **Isolated rerun:** `set -o pipefail; bun test ./bridges/codex-bridge/src/session-titles.test.ts 2>&1 | tee /tmp/orkestrator-session-titles-isolated-acp-image-fixes.log` -> 17 passed, 0 failed, 90 assertions in 6.70 seconds; the affected case passed in 1,918.92 ms.
- **Hypothesis:** The case intentionally exercises several child-process failure modes under one five-second outer budget. It exceeded that budget only while the bridge and root process-heavy suites overlapped and completed well inside it when isolated; neither session-title code nor its tests changed in this work.

## `Electron tmux backend command registration` timeout cluster (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran concurrently with the workspace, bridges, and codex protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** six cases in this one file exhausted their outer budget with no assertion failure. `starts separate tmux sessions for generated tab ids with the same old prefix` (5,005.47 ms), `attaches duplicate client starts to one tmux session unless replacement is explicit` (5,001.94 ms), `generated blocking hooks use an integer timeout and fail closed on expiry` (5,006.09 ms), `reports prompt, exit, capture, send, and transition failures` (5,002.09 ms) each hit the 5,000 ms limit; `serializes stop behind an in-flight start so no tmux session is orphaned` (2,004.37 ms) and `serializes interactive input and interrupts behind a mode transition` (724.26 ms) hit their own shorter internal waits.
- **Suite counts:** root and agent-support group: 1 skipped and 7 failed (these six plus the separate `deduplicates concurrent background starts for one environment` entry below). The workspace, bridges, and codex protocol-lockfile groups passed.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts --parallel 2>&1 | tee /tmp/fix-tmux-isolated.log` -> 173 passed, 0 failed, 615 assertions in 64.43 seconds.
- **Group rerun:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/fix-root-group.log` -> 3,641 passed, 1 skipped, 0 failed, 16,435 assertions across 143 files in 136.42 seconds. The cluster does not reproduce when the root group runs without the other groups competing for workers.
- **Hypothesis:** these cases drive a real `tmux` server and poll its state on wall-clock deadlines, so they are the group's most timing-sensitive file. They fail together, only in the four-group aggregate, and pass both alone and as a whole-group run, which points at CPU contention pushing the polls past fixed real-time budgets rather than at a product race. Replacing the fixed deadlines with an injected clock or an explicit readiness signal should be evaluated before changing the tmux runtime.

## `Electron backend command registry > deduplicates concurrent background starts for one environment` (`tests/unit/electron/commands.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/rev-full-tests.log`, and again in `/tmp/fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran concurrently with the workspace, bridges, and codex protocol-lockfile groups.
- **Failure:** `error: Timed out waiting for deduplicated background start to finish` raised by the file's own `waitForCondition` helper (`tests/unit/electron/commands.test.ts:1115`) after its 3,000 ms poll expired (durations 3,009.85 ms and 3,008.20 ms across the two aggregate runs). No assertion mismatch was reported.
- **Suite counts:** first aggregate: root and agent-support group 3,641 passed, 1 skipped, 1 failed, 16,428 assertions across 145 files in 290.05 seconds; all other groups passed. Second aggregate: same test failed alongside the tmux cluster above.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts --parallel 2>&1 | tee /tmp/rev-commands-isolated.log` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 77.51 seconds.
- **Group rerun:** `bun test ./tests --parallel` -> 0 failed (see the cluster entry above).
- **Hypothesis:** the helper polls for the deduplicated start to settle on a fixed 3,000 ms wall-clock budget while the case also stands up a fake Docker and a fake `gh`. Under aggregate contention the supervised work completes later than that budget allows. The deduplication behaviour itself is what the case asserts, and it holds in both isolated and whole-group runs, so the budget rather than the product logic is the first thing to re-examine.

## `MobileAppShellLayout > opens the project drawer on initial mobile entry and keeps workspace content mounted` (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Later recurrence:** 2026-08-14 after the split below, on the close-button
  half rather than the initial-open half.
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c4cb555c-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The test exceeded Bun's 5,000 ms outer budget and timed out after 5,014.67 ms. No assertion failure was reported. An earlier observation of the same case on this date (`bun run test` into `/tmp/orkestrator-full-tests.log`, web package `bun test src --parallel`) timed out after 5,701.98 ms with no assertion failure; every other test in the owning file passed in that run, including the adjacent `toggles the project drawer closed with a second menu-button tap` at 17.51 ms.
- **Suite counts:** Web package: 4,805 total, 4,803 passed, 1 skipped, 1 failed across 210 files with 14,866 assertions in 104.69 seconds. The backend, root, bridge, protocol, CLI, desktop, and web-public groups passed.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-fix-mobile-layout-isolated.log` -> 23 passed, 0 failed in 4.41 seconds; the affected case passed in 2,197.66 ms. An earlier isolated rerun of the same file also passed 23/0.
- **Root cause:** The case combined the initial Radix drawer auto-focus boundary and a later close-and-restore focus boundary under one five-second test budget. The two behaviors are independent and each already has a distinct user-visible assertion, but their asynchronous focus work accumulated enough aggregate scheduling delay to exhaust the shared budget.
- **Fix:** Split the initial-open and close-button focus behaviors into separate tests so each transition has an independent lifecycle and budget without weakening either assertion.
- **Verification:** The owning file is stress-tested after the split and the subsequent aggregate result is recorded in this change's validation handoff.
- **Related aggregate-only recurrence (2026-08-14):** `closes the initial project drawer from its close button and restores trigger focus` (5,269.69 ms) and `closes the project drawer from its backdrop and restores trigger focus` (5,598.78 ms) timed out while the same file's other tests passed. The originally fixed `opens the project drawer on initial mobile entry and keeps workspace content mounted` case was not among the failures.
- **Original command:** `set -o pipefail; bun --cwd apps/web test src/components/native-agent/AgentNativeTab.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-agent-native-tab-isolated-final.log`
- **Worker configuration:** The command expanded the web package test script to Bun's 18-worker `bun test src --parallel` suite across 211 files; the extra path argument did not limit the package script.
- **Failure and suite counts:** 4,843 passed, 1 skipped, and 3 failed across 4,847 tests; the third failure was the deterministic unbounded-provider context-wheel assertion recorded and fixed in this change.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web ./src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-mobile-app-shell-layout-isolated.log` -> 24 passed, 0 failed, 111 assertions in 8.21 seconds; both affected cases passed.
- **Verification:** `set -o pipefail; bun run --cwd apps/web test 2>&1 | tee /tmp/orkestrator-web-full-coverage-fix.log` -> 4,846 passed, 1 skipped, 0 failed across 4,847 tests in 24.07 seconds.
- **Hypothesis:** The two affected cases each await Radix drawer close and focus restoration under the five-second default budget. Their 4.14-second and 3.00-second isolated durations, combined with the aggregate-only failure and a green subsequent aggregate, point to worker scheduling contention rather than a deterministic drawer behavior failure.
- **Recurrence (2026-08-14, initial-prompt image preview change):** `closes the
  initial project drawer from its close button and restores trigger focus` — one
  of the two cases the split above produced — timed out after 5,398.71 ms with no
  assertion failure during `bun test src --parallel` in `apps/web` (4,845 passed,
  1 skipped, 2 failed across 211 files in 214.19 s; the other failure is the
  separate context-wheel entry below). The first isolated rerun of the owning
  file also timed out at 5,000 ms, but three consecutive reruns after it passed
  24/0 (~5.4-12.3 s each), and the file passed 24/0 on a stashed clean tree.
  Unrelated to the change under test, which touches no layout, drawer, or focus
  code. The split reduced the frequency but did not remove the cause: the
  close-and-restore-focus transition still spends most of a 5,000 ms budget on
  Radix focus scheduling, so aggregate contention alone can exhaust it. Raising
  or removing that single budget is the next thing to evaluate.

## `MobileAppShellLayout` drawer focus-restoration timeouts (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **Status:** open — recurred after the 2026-08-16 resolution sweep
- **Date observed:** 2026-08-14
- **Affected tests:** `closes the project drawer from its backdrop and restores trigger focus` (5,811.44 ms in the first run, 6,830.57 ms in the second) and `closes the initial project drawer from its close button and restores trigger focus` (16,456.55 ms, second run only).
- **Original command:** `set -o pipefail; bun test --cwd apps/web --parallel 2>&1 | tee /tmp/ork-web-tests.log`, and again into `/tmp/ork-web-tests2.log`.
- **Worker configuration:** the web workspace package ran alone with `--parallel` (18 workers on this machine); no other test group ran concurrently.
- **Failure:** both cases exceeded Bun's 5,000 ms outer budget and reported `this test timed out after 5000ms`. No assertion mismatch was reported in either run.
- **Suite counts:** first run 4,835 passed, 1 skipped, 4 failed across 211 files (the other three were two `ActionBar` cases updated by the review-picker change in the same commit and a separate deterministic `AgentNativeTab` failure). Second run 4,836 passed, 1 skipped, 3 failed across 211 files in 268.51 seconds.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/ork-mobile-shell.log` -> 24 passed, 0 failed in 9.17 seconds.
- **Recurrence 2026-08-15:** `closes the initial project drawer from its close button and restores trigger focus` timed out again at 13,029.58 ms during `set -o pipefail; bun test --cwd apps/web --parallel` (4,845 passed, 1 skipped, 2 failed across 211 files in 193.84 seconds; the other failure was the same unrelated deterministic `AgentNativeTab` case). The backdrop case passed in that run. Isolated rerun of the owning file passed 24/0 in 4.23 seconds. Unrelated test processes from another session were competing for CPU during the aggregate run, which is consistent with the mount-cost hypothesis below.
- **Recurrence 2026-08-29:** `bun run test` timed out `closes the project
  drawer from its backdrop and restores trigger focus` after the aggregate
  runner reported 384,107.52 ms against the case's 20-second budget. The web
  workspace reported 5,577 passed, 1 skipped, 3 failed, and 1 trailing error
  across 5,581 tests. The isolated rerun `bun test
  src/components/layout/MobileAppShellLayout.test.tsx` from `apps/web` passed
  25/25 in 4.38 s; the affected case passed in 1,824.25 ms.
- **Relationship to the entry above:** these are the two cases produced by that entry's split. The split gave each focus transition its own budget, and the initial-open case has not recurred, but the two close-and-restore transitions still time out under a fully parallel web-package run.
- **Hypothesis:** each case still mounts the whole mobile shell before it exercises one Radix focus restoration, so the fixed five-second budget is mostly setup. The dismissal assertions themselves hold in isolation, which points at the shared mount cost under 18-way parallelism rather than at the focus behaviour. A lighter mount, or an explicit per-test budget, should be evaluated before the drawer's focus handling is changed.

## `MultiReviewService > keeps a provider alive while a transcript read overlaps fix execution` (`apps/backend/src/core/multi-review-service.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests4.log`; also `set -o pipefail; bun test --cwd apps/backend src/core --parallel 2>&1 | tee /tmp/ork-be-core-tests.log`
- **Worker configuration:** Observed both as the backend workspace package (`bun test src tests --parallel` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently) and as a standalone `bun test --cwd apps/backend src/core --parallel` group of 49 files with no other group running concurrently.
- **Failure:** `expect(received).toBe(expected)` at `multi-review-service.test.ts:278` — expected `2` dispose calls, received `1` (durations 132.84 ms and 217.80 ms). The preceding assertion at line 274 (`disposeCalls === disposalsAfterReady`) had already passed. Line 278 is the second disposal assertion, made after the blocked status call is released and the run reaches `completed`.
- **Suite counts:** In the full aggregate, this was the only failure in three of five consecutive full runs on 2026-08-14 and absent from the other two. In the standalone `src/core` parallel group: 1,590 total, 1,588 passed, 2 failed across 49 files (the other failure was a deterministic assertion in `commands-state-sync.test.ts` unrelated to this entry). Within that group it reproduced on every parallel run rather than intermittently.
- **Isolated rerun:** `bun test --cwd apps/backend src/core/multi-review-service.test.ts` -> 32 passed, 0 failed in one isolated run; another isolated first attempt was 31 passed, 1 failed, then five consecutive repetitions of the same command failed once and passed four times (32 passed, 0 failed).
- **Pre-existing:** confirmed independent of the OpenCode provider-filter change and of later reviewed work. The working tree was stashed (`git stash push --include-untracked`) and the same parallel command rerun on the clean checkout: 1,584 passed, 1 failed, failing on this same test at the same assertion (215.41 ms and 128.45 ms).
- **Hypothesis:** the test releases the blocked status call, polls `snapshot(started.id)` until `phase === "completed"`, and then immediately asserts the final dispose count. Reaching the completed phase and running the provider's teardown appear to be separate awaits, so the assertion can observe the phase transition before the release-path disposal has run. The failure is a timing boundary in the test's completion signal, not evidence of a leaked provider; the durable phase is already correct when it fires. An explicit wait on the dispose count (or an instrumented teardown signal) should be evaluated before changing the service's disposal ordering.
- **Root cause:** Address-all no longer starts a supervised unattended fix turn, so the test was asserting a teardown that the product path no longer performs. The race was between `phase === "completed"` becoming visible and the asynchronous provider dispose after that turn.
- **Fix:** Replace the overlapping-fix-execution case with `MultiReviewService hands the idle consolidation session to interactive addressing`. The handoff takes a bounded provider lease for one liveness read and releases it synchronously, so the test asserts exact call and disposal counts at a deterministic boundary instead of polling for a phase and then racing an asynchronous teardown.
- **Verification:** Owning-file coverage for the rewritten handoff case is included in this change's Multi Review test run.

## `StorageService prompt queues > live lease timer restores and announces a sole claimed head` (`apps/backend/src/core/storage-prompt-queues.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-980919fe-full-tests.log`
- **Worker configuration:** The backend workspace package ran `bun test src tests --parallel` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The queue had recovered the expired sole claim and reached revision 3, but `events` was still `[]` instead of containing the expected `{ resource: "prompt-queue", id: "e1" }` announcement (duration: 44.42 ms).
- **Suite counts:** Backend package: 1,647 total, 1,646 passed, 1 failed across 55 files. The aggregate also had one separate deterministic root-suite failure from the reviewed activity-source change.
- **Isolated rerun:** `bun test --cwd apps/backend src/core/storage-prompt-queues.test.ts` -> 57 passed, 0 failed, 197 assertions in 1.87 seconds; the target passed in 51.94 ms.
- **Recurrence (session-liveness review, 2026-08-14):** `set -o pipefail; bun test --cwd apps/backend src tests --parallel` at `c4ce823fb218e0f858115c0e0ada81203998c10a` failed identically — `expect(received).toContainEqual(expected)` with `Expected to contain: ObjectContaining { resource: "prompt-queue", id: "e1" }` and `Received: []` at `storage-prompt-queues.test.ts:366:22` (duration: 83.60 ms). Backend package: 1,696 total, 1,695 passed, 1 failed across 55 files. The immediate isolated rerun, `bun test --cwd apps/backend ./src/core/storage-prompt-queues.test.ts`, passed all 57 tests. A preceding backend run at the same head passed this test and failed a different one in the same package, so the two alternate rather than compound. Evidence: `/tmp/rev-backend-tests-c4ce823f.log`, `/tmp/rev-isolated-storage-prompt-queues.log`.
- **Hypothesis:** The test uses a 25 ms real-time lease, clears claim-announcement events immediately after the claim call, and then polls the durable queue separately from the listener. Under aggregate scheduling, lease recovery can race that reset/observation boundary even though the recovered queue state is correct. A deterministic clock or explicit recovery boundary should be evaluated before changing the product timer.

## `MultiReviewReviewerTab > keeps the transcript full-height and does not overlap slow refreshes` (`apps/web/src/components/review/MultiReviewTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-review-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel` while the remaining workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The test timed out after 1,029.86 ms waiting for Virtuoso to expose the completed `Reviewer report` article. The failure DOM showed the article after the timed-out query snapshot, so the production request had completed and rendered but missed the test's one-second polling window under aggregate load.
- **Suite counts:** Web package: 5,647 total, 5,645 passed, 1 skipped, 1 failed across 231 files. All other aggregate groups passed.
- **Isolated rerun:** The owning file had passed before the aggregate run (6 passed, 0 failed). After the test fix, `bun test --cwd apps/web src/components/review/MultiReviewTab.test.tsx --rerun-each 10` passed all 60 executions with 290 assertions in 841 ms.
- **Root cause:** The concurrency test coupled its completion signal to Virtuoso's deferred item rendering even though the behavior under test was request serialization. Aggregate scheduling could delay that unrelated render past Testing Library's one-second wait.
- **Fix:** Resolve and await the controlled transcript request inside asynchronous `act()`, then wait for the instrumented active-request count to reach zero and assert its maximum remained one. The existing rendering test continues to cover the report UI separately.
- **Verification:** Ten consecutive owning-file repetitions passed with zero failures. The subsequent aggregate result is recorded in this change's validation handoff.

## `EnvironmentSettingsDialog > uses top agent tabs and shows MCP servers, plugins, and skills for each agent` (`tests/unit/components/EnvironmentSettingsDialog.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-full-tests.log`
- **Worker configuration:** the root and agent-support group ran as `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel=4` (`4x PARALLEL`).
- **Failure:** `expect(received).toEqual(expected)` at `EnvironmentSettingsDialog.test.tsx:304` — expected `["Claude", "Codex", "OpenCode"]`, received those plus `"Rendered"` and `"Raw"` (duration: 15.27 ms).
- **Suite counts:** root and agent-support group: 3,639 total, 3,637 passed, 1 skipped, 1 failed; the workspace, bridges, and codex protocol lockfile groups passed.
- **Isolated rerun:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` -> 20 passed, 0 failed in 471 ms.
- **Root cause:** the assertion used the document-wide `screen.getAllByRole("tab")`, so it matched every element with `role="tab"` in the worker's shared happy-dom document, not only the dialog's own tablist. `"Rendered"` and `"Raw"` are the view tabs rendered by
  `apps/web/src/components/markdown/MarkdownEditorTab.tsx`; a sibling file that ran earlier in the same worker left them mounted. The leak is pre-existing, but the native-agent consolidation deleted ten large test files, which redistributed files across workers and paired this file with a leaking neighbour for the first time.
- **Fix:** scope the query to `screen.getByRole("tablist", { name: "Agent extensions" })` so the assertion can only observe this dialog's tabs. The `aria-label` was already present on the `TabsList`.
- **Verification:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` and a full `bun run test` after the fix; see the run recorded alongside the native-agent projection changes.

## `agent-test artifact sanitizer > stages the redacted trace beside the original so the swap cannot cross filesystems` (`e2e/agent-testing/artifact-sanitizer.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran as `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel=4` (`4x PARALLEL`).
- **Failure:** expected the staged archive basename to be `trace.zip`, but received an empty string (duration: 27.44 ms).
- **Suite counts:** root and agent-support group: 3,639 total, 3,637 passed, 1 skipped, 1 failed; the other validation groups passed.
- **Isolated rerun:** `bun test ./e2e/agent-testing/artifact-sanitizer.test.ts` -> 3 passed, 0 failed in 91 ms.
- **Hypothesis:** the owning file passes from a clean process, so the failure depends on aggregate execution state or scheduling. The available assertion does not identify which shared condition produced the empty basename; no more specific root cause is established yet.

## Unattributable `bun run test` failure — aggregate output truncated on exit (`scripts/test-all.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail && bun run test 2>&1 | tee /tmp/fix2-full-tests.log`, and an immediate repeat into `/tmp/fix3-full-tests.log`.
- **Worker configuration:** the standard four concurrent groups from `buildConcurrentGroups`, then iOS.
- **Failure:** both runs exited 1 with **no identifiable failing test**. The log ended mid-line — `(pass) claude-client > listSessions > returns sessions array on success [0.09error: script "test" exited with code 1` — after 2,628 and 2,653 lines (278 KB) against the 46,000+ lines a passing run produces. In the second run the workspace group had already printed `PASS`, so the failure was in a group whose block never reached the log at all.
- **Suite counts:** not recoverable; the group summaries were in the discarded output.
- **Isolated rerun:** every suite passed individually — workspace group direct (`turbo run test:workspace`, 12/12 successful in 2m10s), and the aggregate itself passed on the next two runs (`bun scripts/test-all.ts > file`, exit 0, 46,489 lines; `bun run test | tee`, exit 0, 46,172 lines).
- **Root cause:** of the *lost evidence*, not of the underlying failure. `main()` ended a failing run with `process.exit(status)`. Group output is buffered and printed as one multi-megabyte block, and a pipe — which is exactly what the documented `| tee` workflow makes stdout — accepts that write asynchronously. `process.exit` tears the process down mid-flush. A direct probe confirmed the size: writing 3,000,015 bytes then calling `process.exit(1)` delivered 196,608 bytes (one pipe buffer) through a pipe and dropped the tail marker, while `process.exitCode = 1` delivered all 3,000,015 bytes and preserved the status.
- **Fix:** `scripts/test-all.ts` now sets `process.exitCode` and lets the runtime drain stdout and exit on its own. `tests/unit/test-all.test.ts` covers the default exit path directly, and `tests/unit/monorepo-scripts.test.ts` asserts `process.exit(status)` never returns.
- **Verification:** `bun run test 2>&1 | tee` -> exit 0 with the complete 46,172-line log. The underlying failure has not recurred in the runs since; if it returns, its group block will now survive to the log and can be recorded here properly.

## `BuildChatTab agent messaging > disables the send button and shows progress while a send is in flight` (`apps/web/src/components/build-pipeline/BuildChatTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-13; recurred 2026-08-14
- **Original command:** `bun test src --parallel` from `apps/web`.
- **Worker configuration:** Bun's default parallel worker pool for the complete web package, run alongside the root suite during native-agent consolidation verification.
- **Recurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/rev-d78f50fb-full-tests.log` at commit `d78f50fb`, with the workspace, root, bridge, and protocol-lockfile groups running concurrently. `(fail) ... [5228.39ms]` — `this test timed out after 5000ms`, no assertion failure reported. Web package: 5,647 total, 5,645 passed, 1 skipped, 1 failed across 231 files; every other group passed. Isolated rerun `bun test --cwd apps/web src/components/build-pipeline/BuildChatTab.test.tsx` -> 75 passed, 0 failed, 230 assertions in 3.36 seconds. The signature matches the original: a bare outer-budget timeout that clears completely in isolation, so the hypothesis below is unchanged.
- **Failure:** `(fail) BuildChatTab agent messaging > disables the send button and shows progress while a send is in flight [6090.90ms]`. The filtered aggregate log did not retain a narrower assertion message; the duration exceeded Bun's five-second default test budget.
- **Suite counts:** 5,548 tests across 227 files; 5,546 passed, 1 skipped, and 1 failed in 21.24 seconds.
- **Isolated rerun:** `bun test src/components/build-pipeline/BuildChatTab.test.tsx` from `apps/web` -> 75 passed, 0 failed, 230 assertions in 3.54 seconds; the affected test passed in 2,718.90 ms.
- **Recurrence (Codex user-echo follow-up, 2026-08-14):** `bun run test` ran the web package as `bun test src --parallel=2` alongside the other aggregate groups. The case timed out after 5,000 ms (reported duration 5,085.96 ms); the web package reported 5,644 passed, 1 skipped, and 2 failed across 5,647 tests, while the full aggregate reported 14,072 passed, 13 skipped, and 2 failed across 14,087 tests. The immediate isolated rerun, `bun test ./src/components/build-pipeline/BuildChatTab.test.tsx` from `apps/web`, passed all 75 tests with 230 assertions in 4.25 seconds; the affected case passed in 3,061.64 ms. This is the same timeout shape as the original observation and does not touch the Codex files changed by the follow-up.
- **Recurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-native-consolidation-full-tests.log` reproduced the same five-second timeout while the web package ran with Bun's 18-worker parallel pool inside the four-group aggregate. The web suite reported 4,911 passed, 1 skipped, and 1 failed across 224 files; the target duration was 5,640.01 ms. The immediate isolated rerun, `bun test ./src/components/build-pipeline/BuildChatTab.test.tsx --parallel` from `apps/web`, passed all 75 tests with 230 assertions in 3.61 seconds; the target passed in 2,680.68 ms. Evidence: `/tmp/orkestrator-build-chat-tab-isolated-after-aggregate.log`.
- **Recurrence (2026-08-14, native-agent final gate):** `/tmp/orkestrator-native-consolidation-full-tests-rerun.log` reproduced the same timeout at 5,843.17 ms with the same 4,911 pass, 1 skip, 1 fail web-package result. The root, bridge, and protocol-lockfile groups all remained green.
- **Root cause:** The test used two polling `waitFor` calls around transitions that it already controlled exactly. Under aggregate worker load, scheduling those polls could exhaust Bun's five-second outer budget even though the mocked backend promise and both React transitions were behaving correctly.
- **Fix:** Assert the synchronous in-flight render immediately after the click, then release the controlled promise inside async `act` and assert the settled render after React has flushed. No product timeout or implementation behavior changed.
- **Verification:** `bun test ./src/components/build-pipeline/BuildChatTab.test.tsx --rerun-each 3` passed all 225 executions with 687 assertions in 1.79 seconds; the affected test completed in 2.93 ms on the third run. Evidence: `/tmp/orkestrator-build-chat-tab-flake-fix-stress.log`.

## `authoritative resync > converges renderer collections through the real command boundary after a backend restart` (`apps/web/src/lib/store-resource-sync.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `bun run test` (web workspace task: `bun test src --parallel=2`).
- **Worker configuration:** Two Bun web workers while the remaining workspace packages, root, bridge, protocol-lockfile, and iOS groups ran through the aggregate runner.
- **Failure:** `expect(received).toEqual(expected)` at `store-resource-sync.test.ts:1677`; the expected single-project collection was `[]` after the simulated backend restart (duration: 281.65 ms).
- **Suite counts:** Web package: 5,647 total, 5,644 passed, 1 skipped, 2 failed. Full aggregate: 14,087 total, 14,072 passed, 13 skipped, 2 failed.
- **Isolated rerun:** `bun test ./src/lib/store-resource-sync.test.ts` from `apps/web` -> 66 passed, 0 failed, 144 assertions in 7.19 seconds; the affected case passed in 233.76 ms.
- **Hypothesis:** No root cause is established from one aggregate-only occurrence. The failure was a missing project collection after the test's real backend restart boundary, while the same boundary converged in the immediate isolated run; future recurrence should capture backend process timing and resource-resync generation ordering before changing the product assertion.

## `web-public install.sh > runs on both supported platforms` (`tests/unit/install-script.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun test tests --parallel`
- **Worker configuration:** Bun's default parallel worker pool for the root group, run on its own (no other test group running concurrently).
- **Failure:** `(fail) web-public install.sh > runs on both supported platforms [5001.03ms]` — `this test timed out after 5000ms`. The suite reported 2 failures for that run; the other was the deterministic `packages/cli` release-version drift, which is unrelated. The same command was run four times in total on the same commit: three runs reported `3900 pass, 1 skip, 1 fail` (the version drift alone) in 109.9s–111.9s, and one reported `2 fail`, so the observed rate is roughly one in four.
- **Suite counts:** Failing run: 2 fail across 3902 tests in 148 files. Passing runs: 3900 pass, 1 skip, 1 fail, 16906 expect() calls, 3902 tests across 148 files.
- **Isolated rerun:** `bun test tests/unit/install-script.test.ts` -> 10 pass, 0 fail, 25 assertions in 2.38 seconds.
- **Recurrence (2026-08-14):** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests-native-consolidation.log` again timed out at 5,001.03 ms. The root suite reported 3,631 passed, 1 skipped, and 2 failed across 143 files; the other failure was the separate runtime-copy timeout below. An immediate isolated rerun passed all 10 tests with 25 assertions in 4.43 seconds; the target completed in 734.37 ms. Evidence: `/tmp/orkestrator-install-script-isolated.log`.
- **Root cause:** The case coupled two independent process-spawning platform checks to one five-second outer budget. Under root-suite worker contention, the combined shell and stub-launcher startup latency could exhaust that shared budget even though each supported platform behaved correctly.
- **Fix:** Give Darwin and Linux independent test cases and independent budgets. Both still execute the real installer harness and retain the same exit-code assertion.
- **Verification:** `bun test ./tests/unit/install-script.test.ts --test-name-pattern 'runs on supported platform' --rerun-each 10` passed 20/20 platform cases in 7.04 seconds. The final `bun run test` aggregate passed the root group with 3,638 tests and no failures. Evidence: `/tmp/orkestrator-install-script-flake-fix-stress.log` and `/tmp/orkestrator-native-consolidation-full-final.log`.

## `container runtime environment wiring > Codex configuration copy inspection failures warn and skip the entry` (`tests/unit/runtime-env-wiring.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests-native-consolidation.log`
- **Worker configuration:** Bun's 18-worker parallel pool for the root group.
- **Failure:** `this test timed out after 5000ms` at 5,508.54 ms.
- **Suite counts:** 3,634 total, 3,631 passed, 1 skipped, and 2 failed across 143 files; the other failure was the install-script flake above.
- **Isolated rerun:** `bun test ./tests/unit/runtime-env-wiring.test.ts` -> 53 passed, 0 failed, 419 assertions in 5.87 seconds; the affected test passed in 1,194.03 ms. Evidence: `/tmp/orkestrator-runtime-env-wiring-isolated.log`.
- **Root cause:** The case deliberately launches four complete shell harnesses to force independent `wc`, `find`, `du`, and malformed-output inspection failures. The default five-second outer test budget covered all four processes together and was exhausted under aggregate process-startup contention; each fail-closed assertion passed in isolation.
- **Fix:** Give this multi-process integration case a 15-second outer budget. The production commands, failure behavior, and every copy-rejection assertion are unchanged.
- **Verification:** `bun test ./tests/unit/runtime-env-wiring.test.ts --test-name-pattern 'Codex configuration copy inspection failures' --rerun-each 10` passed 10/10 in 7.13 seconds, with individual executions at 690.82-734.65 ms. The final `bun run test` aggregate passed the root group with 3,638 tests and no failures. Evidence: `/tmp/orkestrator-runtime-copy-flake-fix-stress.log` and `/tmp/orkestrator-native-consolidation-full-final.log`.

## `orkestrator CLI package` built-artifact checks (`packages/cli/tests/cli.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Worker configuration:** Four Bun workers in the root group while the workspace, bridge, and protocol-lockfile groups ran concurrently. The workspace group also ran the CLI package's `test:workspace` task against the same package directory.
- **Failure:** Six built-artifact checks failed because `packages/cli/dist/main.js` and related staged resources were absent: `stages a self-contained backend and both bridge entrypoints`, `declares exactly the packages its bundles resolve at runtime`, `resolves every unbundled import from the directory its bundle ships in`, `packs the runtime payload and nothing else`, `starts and gracefully stops the packaged backend`, and `starts when the caller's environment already sets NODE_ENV`. The root group completed in 138.6 seconds. A separate release-version assertion failed both aggregate and isolated runs (`packages/cli/package.json` is `2.7.8`, while the root package is `2.8.0`) and is therefore a deterministic failure, not part of this flake.
- **Suite counts:** The aggregate root group's final counts were not retained in the buffered output; the six artifact failures above were retained along with the separate deterministic version failure.
- **Isolated rerun:** `bun test packages/cli/tests/cli.test.ts` -> all six artifact checks passed; the file reported 7 passed, 1 failed, 18 assertions in 2.33 seconds, with only the deterministic release-version assertion still failing.
- **Recurrence:** `bun run test` on 2026-08-13 again raced the workspace CLI build against the root CLI file: `resolves every unbundled import from the directory its bundle ships in` failed with a missing `resources/claude-bridge/dist/index.js`, and `packs the runtime payload and nothing else` observed a package missing `dist/main.js` and both bridge bundles. The immediate `bun test packages/cli/tests/cli.test.ts` rerun passed every artifact check (7 passed, 1 deterministic version failure, 18 assertions in 2.10 seconds).
- **Recurrence (credential-refresh follow-up):** `bun run test` on 2026-08-13 reproduced only `packs the runtime payload and nothing else` in the four-worker root group while the workspace CLI task ran concurrently. The packed file list omitted `dist/main.js`, `resources/claude-bridge/dist/index.js`, and `resources/codex-bridge/dist/index.js`; the root group reported 3,910 passed, 1 skipped, and 1 failed across 148 files in 111.53 seconds. The immediate isolated rerun, `bun test packages/cli/tests/cli.test.ts`, passed all 8 tests with 27 assertions in 2.04 seconds.
- **Recurrence (agent-test development mode):** `bun run test` on 2026-08-14 reproduced `packs the runtime payload and nothing else` (exit 1 after 10.49 ms) and `starts and gracefully stops the packaged backend` (`Cannot find module '../dist/main.js'`, 22.67 ms). The root group reported 3,886 passed, 1 skipped, and 3 failed across 148 files in 122.17 seconds; the third failure was a deterministic orchestration assertion. The immediate `bun test packages/cli/tests/cli.test.ts` rerun passed all 8 tests with 27 assertions in 2.46 seconds.
- **Root cause:** Bun treats the bare positional argument `tests` as a substring path filter. The aggregate root command therefore selected both `./tests` and `packages/cli/tests` while Turbo independently ran the CLI workspace task. The CLI build starts by recursively removing `packages/cli/dist` and `packages/cli/resources`, so the duplicate root tests could inspect or execute those paths during restaging.
- **Fix:** The aggregate runner now passes the explicit relative path `./tests`, which Bun scans as a directory and which excludes package-owned test directories. The CLI package remains covered once by its Turbo workspace task.
- **Verification:** `bun test packages/cli/tests/cli.test.ts` passed 8 tests with 0 failures and 27 assertions in 2.46 seconds. The corrected `bun run test` aggregate then passed the workspace group (CLI 8/8), root group (3,881 passed, 1 skipped, 0 failed), bridges (2,318 passed, 11 skipped, 0 failed), protocol lockfile, and iOS (40 passed, 0 failed).

## `orkestrator CLI package` packaged-backend lifecycle (`packages/cli/tests/cli.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `bun run test` (workspace group, Turbo task `@orkestrator/cli#test:workspace`).
- **Worker configuration:** Turbo's workspace group running concurrently with the root, bridge, and protocol-lockfile groups. Unlike the resolved built-artifact flake above, the CLI file was selected exactly once — the duplicate-selection root cause fixed there does not apply here.
- **Failure:** Two cases in the same run.
  1. `starts and gracefully stops the packaged backend` (4,327.86 ms): `expect(received).toBe(expected)`, `Expected: 0`, `Received: 143`, at `cli.test.ts:267:55`, followed by `killed 1 dangling process`. 143 is SIGTERM, so the packaged backend did not complete its graceful shutdown inside the window the test allows before the harness force-kills it.
  2. `starts when the caller's environment already sets NODE_ENV` (5,001.07 ms): `this test timed out after 5000ms`, plus an unhandled `error: Packaged backend did not become ready:` (empty stderr payload) from `startPackagedBackend` at `cli.test.ts:145:15`, called from `cli.test.ts:274:45`.
- **Suite counts:** CLI package 6 passed, 2 failed, 1 error; Turbo reported `Tasks: 5 successful, 7 total` with `Failed: orkestrator#test:workspace`. Concurrent groups were green: root 3,903 passed / 1 skipped / 0 failed; bridges 2,372 passed / 11 skipped / 0 failed; codex protocol lockfile passed. Turbo aborted the workspace group on this failure, so the web, desktop, and web-public workspace tasks did not execute in that run and iOS never started.
- **Isolated rerun:** `bun run --cwd packages/cli test` (builds, then `bun test tests --parallel`) -> 8 passed, 0 failed, 27 assertions in 2.17 seconds. Both affected cases passed.
- **Recurrence (attachment-only startup fix, 2026-08-15):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-image-only-full-tests.log` failed `starts and gracefully stops the packaged backend` after 5,001.45 ms while the workspace group competed with the root, bridge, and protocol groups. Readiness never arrived before the outer budget, cleanup killed one dangling process, and `startPackagedBackend` subsequently reported an empty-stderr readiness failure between tests. The CLI package reported 7 passed and 1 failed before Turbo aborted the backend task with exit 130; root passed 3,656 with 1 skipped, bridges passed 2,425 with 11 skipped, and the protocol lockfile passed. The immediate isolated rerun, `bun test --cwd packages/cli tests/cli.test.ts`, passed all 8 tests with 27 assertions in 6.79 seconds; the affected case completed in 3,560.81 ms. Evidence: `/tmp/orkestrator-image-only-full-tests.log` and `/tmp/orkestrator-cli-packaged-backend-isolated.log`.
- **Hypothesis:** No root cause is established from one occurrence. Both cases spawn the real packaged backend and wait on a fixed wall-clock budget — readiness in one, graceful exit in the other — while three other test groups saturate the machine. Neither failure mode involves a missing artifact, which is what separates this from the resolved entry above. A recurrence should capture backend startup and shutdown timings before the budgets are changed, since raising them would also hide a genuine shutdown regression.
- **Collateral note:** Because a workspace-group failure aborts the remaining Turbo tasks, this flake silently drops web/desktop/web-public coverage from an aggregate run. Treat a workspace-group failure as "the rest of that group did not run", not as "the rest of that group passed".

## `AcpChatTab > keeps a rejected initial prompt available for a remount retry` (`apps/web/src/components/acp/AcpChatTab.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun run --cwd apps/web test` (`bun test src --parallel`)
- **Worker configuration:** Bun reported `18x PARALLEL` across the web package.
- **Failure:** `expect(received).toHaveBeenCalledTimes(expected)` at `AcpChatTab.test.tsx:190` -- `Expected number of calls: 2`, `Received number of calls: 1` (durations 7.45-58.24 ms).
- **Suite counts:** 5,507 total, 5,505 passed, 1 skipped, 1 failed across 225 files.
- **Isolated rerun:** `bun test src/components/acp/AcpChatTab.test.tsx` from `apps/web` -> 7 passed, 0 failed, repeated 10 times with zero failures. The aggregate suite reproduced the failure in roughly two runs out of five.
- **Root cause:** The test dispatches a failing initial prompt, unmounts, remounts, and then waits with `toHaveBeenLastCalledWith`. The first mount had already recorded a call with those exact arguments, so the `waitFor` was satisfied immediately and nothing actually waited for the remount to connect and dispatch. The following `toHaveBeenCalledTimes(2)` then raced the second mount's asynchronous bridge handshake, and lost whenever aggregate load delayed it.
- **Fix:** Wait on the call *count* (`waitFor(() => expect(...).toHaveBeenCalledTimes(2))`) and assert the arguments afterwards, so the wait is tied to the event the test is actually about.
- **Verification:** `bun run --cwd apps/web test` -> 6 consecutive runs, 5,506 passed, 0 failed each. `bun test src/components/acp/AcpChatTab.test.tsx` from `apps/web` -> 10 consecutive runs, 0 failures.

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

## `standalone backend service` Tailscale Serve lifecycle tests (`apps/backend/tests/standalone.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout (reported duration 5,000.60 ms); Bun also reported an unhandled `Backend exited during startup:` error with empty stderr from `startBackend` and killed three dangling processes
- **Suite counts:** Backend package: 1,519 tests, 1,518 passed, 1 failed, plus 1 between-test error
- **Isolated rerun:** `bun test ./tests/standalone.test.ts` from `apps/backend` -> 8 passed, 0 failed; the target passed in 2,159.94 ms
- **Recurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log` ran the backend workspace as `bun test src tests --parallel` alongside the web, root, bridge, and protocol-lockfile groups. The target completed its startup assertions but the final graceful-shutdown assertion expected exit code `0` and received signal-derived exit code `143` (duration: 4,834.76 ms).
- **Recurrence suite counts:** Backend package: 1,684 total, 1,682 passed, 2 failed across 55 files; the other failure was the separate MultiReview flake below. Root/agent-support and the protocol lockfile passed; the bridge group had one separate aggregate-only failure.
- **Recurrence isolated rerun:** `bun test ./tests/standalone.test.ts --parallel` from `apps/backend` -> 8 passed, 0 failed in 10.82 seconds; the target passed in 2,304.52 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-backend-standalone-cwd.log`.
- **Recurrence (attachment-only startup fix, 2026-08-15):** `set -o pipefail; bun run --cwd apps/backend test:workspace 2>&1 | tee /tmp/orkestrator-image-only-backend-suite.log` ran with Bun's two-worker parallel pool and timed out two subprocess lifecycle cases at the five-second outer budget. `exits without a leftover listener when environment-managed Serve setup fails` timed out after 5,009.91 ms, and `rejects Tailscale Serve with a non-IPv4-loopback listener` timed out after 5,013.07 ms. Both produced empty stderr instead of their expected startup errors, and Bun killed one dangling process. The package reported 1,706 passed, 2 failed, and 1 between-test error across 55 files. The immediate isolated rerun, `bun test tests/standalone.test.ts` from `apps/backend`, passed all 8 tests with 36 assertions in 26.78 seconds; the affected cases completed in 2,895.66 ms and 2,473.60 ms. Evidence: `/tmp/orkestrator-image-only-backend-suite.log` and `/tmp/orkestrator-image-only-backend-standalone-isolated.log`.
- **Hypothesis:** The recurrences consistently involve real backend subprocess startup or shutdown under aggregate load. One run reached shutdown but observed raw signal exit code 143; the latest run exhausted the five-second outer budgets before the expected startup errors became available. The evidence does not yet establish whether process launch latency, shutdown-handler installation, signal delivery, or teardown ordering is the common cause.
- **Previous root cause:** The original occurrence exhausted the five-second test budget while performing two complete backend lifecycles.
- **Previous fix:** Give the two-lifecycle integration test a 20-second budget while preserving the startup helper's narrower deadline and all functional assertions.
- **Previous verification:** After building the standalone backend, `bun test tests/standalone.test.ts --test-name-pattern 'can own a Tailscale Serve listener' --rerun-each 10` from `apps/backend` -> 10 passed, 0 failed; individual runs completed in 2,037.57-2,896.36 ms.

## `MultiReviewService keeps a provider alive while a transcript read overlaps fix execution` (`apps/backend/src/core/multi-review-service.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The backend workspace ran `bun test src tests --parallel` while the web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** After the overlapping transcript read completed and fix execution reached `completed`, the provider had one disposal instead of the expected two (`Expected: 2`, `Received: 1`) at `multi-review-service.test.ts:278` (duration: 183.68 ms).
- **Suite counts:** Backend package: 1,684 total, 1,682 passed, 2 failed across 55 files. Root/agent-support and the protocol lockfile passed; the bridge group had one separate aggregate-only failure.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts --parallel` from `apps/backend` -> 32 passed, 0 failed in 3.16 seconds; the target passed in 56.74 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-multi-review.log`.
- **Hypothesis:** The workflow reached its durable completed phase before the asynchronous provider-disposal observation became visible under aggregate scheduling. The isolated run proves the production path can satisfy the assertion, but this occurrence does not establish whether the test needs an explicit disposal boundary or the service is publishing completion before cleanup settles.
- **Root cause:** Same overlapping-fix-execution teardown race as the entry above. Address-all no longer starts that supervised turn.
- **Fix:** Same replacement case as the entry above.
- **Verification:** Owning-file coverage for the rewritten handoff case is included in this change's Multi Review test run.

## `titles > a generated title is persisted for every tab sharing the thread` (`bridges/codex-bridge/src/app-server-runtime.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** The persisted session metadata assertion at `app-server-runtime.test.ts:6651` received additional current metadata fields instead of the expected partial object after the generated shared-thread title was written (duration: 76.07 ms).
- **Suite counts:** Bridge group: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files. Root/agent-support and the protocol lockfile passed; the backend workspace had two separate aggregate-only failures.
- **Isolated rerun:** `bun test ./src/app-server-runtime.test.ts --parallel` from `bridges/codex-bridge` -> 271 passed, 0 failed in 3.54 seconds; the target passed in 29.91 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-app-server-runtime.log`.
- **Hypothesis:** Another aggregate bridge test appears to have populated optional session metadata before this assertion read the shared persisted record. The isolated owner file preserves the expected partial state, but the available diff does not identify the cross-file writer, so no product assertion has been weakened.
- **Recurrence (ACP usage replay guard, 2026-08-16):** `bun run test:logged -- --name full-suite2 -- bun run test` failed it again at 146.22 ms; bridges group: 2,544 passed, 11 skipped, 1 failed. Isolated rerun `bun test bridges/codex-bridge/src/app-server-runtime.test.ts` -> passed in 4.2 s. The change under validation touches only `bridges/acp-bridge`, which shares no persisted metadata with the codex bridge, so the cross-file writer remains unidentified. Worth noting for the next investigation: the immediately preceding aggregate run of the same tree passed this file and failed an acp-bridge case instead, so which bridge test loses this race also varies between runs.

## `NativeAgentService > starts and stops the observe-only timer with the service lifecycle` (`apps/backend/src/core/native-agent-service.test.ts`)

- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test` (backend workspace group:
  `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the
  web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** After initialization made one interaction-list call, the test
  expected a second call after sleeping 130 ms for a 100 ms interval, but the
  call count remained one (`Expected: > 1`, `Received: 1`; 154.69 ms).
- **Suite counts:** Backend package: 1,776 total, 1,775 passed, 1 failed across
  55 files.
- **Isolated rerun:** `bun run test:logged -- --name
  isolate-native-agent-service-timer -- bun --cwd=apps/backend test
  ./src/core/native-agent-service.test.ts --only-failures` → passed.
- **Root cause:** The test assumed sleeping 30 ms beyond the configured timer
  interval guaranteed the callback had run. Aggregate scheduling delayed that
  callback past the fixed sleep even though the lifecycle behavior was intact.
- **Fix:** Poll the observable call-count transition with the file's existing
  two-second bounded helper. The shutdown half retains its fixed observation
  window because it proves that no further timer callback occurs.
- **Verification:** `bun run test:logged -- --name
  stress-native-agent-service-timer -- bun --cwd=apps/backend test
  ./src/core/native-agent-service.test.ts --test-name-pattern "starts and stops
  the observe-only timer with the service lifecycle" --rerun-each 20
  --only-failures` → passed all 20 reruns.

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

## `runtime environment refresh > sources configured runtime helper and applies refreshed shell environment` (`bridges/codex-bridge/src/runtime-env.test.ts:179`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-11
- **Original command:** `bun test bridges --parallel`
- **Worker configuration:** Bun's parallel bridge-suite worker pool
- **Failure:** The test exceeded Bun's 5,000 ms timeout.
- **Suite counts:** 2,280 total, 2,268 passed, 11 skipped, 1 failed across 65 files with 7,400 assertions.
- **Isolated rerun:** `bun test ./bridges/codex-bridge/src/runtime-env.test.ts` -> 10 passed, 0 failed with 30 assertions in 102 ms; the affected test passed in 6.06 ms.
- **Hypothesis:** The helper-spawn test is sensitive to aggregate bridge-suite scheduling or process-start latency. It completed far below the timeout in isolation, but this single observation does not identify a narrower production or test defect.

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
- **Root cause:** An announcement the service is correct to suppress, not a lost
  filesystem notification. `revert_local_file` only *requests* its scan
  (`commands.ts` calls `diffStatsService.refresh` without awaiting it), so the
  reverted counts are not published when the command returns. The test rewrote
  the file immediately afterwards. When the revert's scan then ran, it read the
  rewritten tree and produced `{additions: 1, deletions: 0, filesChanged: 1}` -
  identical to the pre-revert `entry.last` - so `DiffStatsService.run` returned
  at its `isSameStats` check without emitting *and without moving* `entry.last`.
  From that point the entry was pinned to the pre-revert counts, every later
  scan compared equal, and no scan could ever announce the rewrite. The test
  could only time out.
- **Corrects an earlier entry:** a previous revision of this entry claimed the
  refresh "reused the stale empty list". That is not possible:
  `DiffStatsService.run` never reads `entry.cachedChanges`, and the wired `scan`
  always shells out to git. It also recorded a bounded write-and-refresh retry
  loop as the fix. That loop cannot work, because every retry produces the same
  suppressed counts - see the reproduction below, where it failed 5 out of 5.
- **Reproduction:** forcing the interleaving deterministically - rewriting the
  file immediately after `revert_local_file` returns, so the revert's scan
  cannot land first - failed 5 of 5 runs at 3,261-3,344 ms, matching the
  original 3,397.10 ms failure and message. The retry loop was still in place
  for that run, which is how it was ruled out as a fix.
- **Fix:** Wait for the reverted counts (`filesChanged === 0`) to be announced
  before rewriting the file, so the rewrite is a genuine change rather than a
  no-op the service is right to swallow. The write and the refresh are then a
  single pair again, and the revert/delete assertions are unchanged.
- **Verification:** `bun test tests/unit/electron/commands.test.ts
  --test-name-pattern 'invalidates the shared file-list cache after local revert
  and delete' --rerun-each 25` -> 25 passed, 0 failed in 12.90 s.
- **Coverage note:** the assertion is satisfied by whichever production path
  rescans first, the explicit refresh or the watcher; neutering
  `refresh_environment_diff_stats` leaves it passing on the watcher alone. That
  is deliberate - `refresh` forcing a scan is isolated in
  `tests/unit/backend/diff-stats-service.test.ts:458`, and the suppression
  behaviour above is covered at line 212 of the same file.
- **Test budget:** the test now carries `ASYNC_TEST_BUDGET_MS`, like the other
  tests in the file that await the wait helper twice. Without it, two 3-second
  bounded waits can exceed Bun's 5-second default and report a generic timeout
  instead of naming the condition that never became true.

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
- **Recurrence (2026-08-11), steering-segmentation fix validation:** `bun run test` again failed the workspace group on this assertion in 27.5 seconds, leaving iOS unrun. Immediate isolation with `bun test ./src/core/pr-monitor-agent-completion.integration.test.ts` from `apps/backend` passed all 3 tests with 11 assertions in 463 ms; the affected test passed in 100.58 ms. Direct follow-up validation passed the complete web workspace (5,465 passed, 1 skipped) and web-public workspace (26 passed), confirming the changed bridge code was not involved in the aggregate failure.
- **Counter-observation (2026-08-12), steering-segmentation review fixes:** the immediately preceding aggregate run at head `5d92e452` failed here again, but after the review fixes `bun run test` passed every group on the first attempt — workspace, `root (tests/)` in 91.4 s, `bridges` in 18.8 s, the codex protocol lockfile in 3.9 s, and iOS `Executed 40 tests, with 0 failures`. Notably the workspace group was **not** in the fast 27–28 s band this time; it ran the full web build and suite. This is one more data point for the wall-clock correlation below rather than evidence the flake is fixed: nothing in the reviewed change touches the PR monitor, so treat the status as still open.
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

## `EnvironmentSettingsDialog > uses top agent tabs and shows MCP servers, plugins, and skills for each agent` (`tests/unit/components/EnvironmentSettingsDialog.test.tsx:304`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-13
- **Original command:** `bun run test` on an 18-logical-core macOS host, whose root group is `bun test tests --parallel=<planWorkers rootShare>`
- **Failure:** `expect(received).toEqual(expected)` — `screen.getAllByRole("tab")` returned `["Claude", "Codex", "OpenCode", "Rendered", "Raw"]` against the expected `["Claude", "Codex", "OpenCode"]`. Duration 20.69 ms.
- **Suite counts for that run:** root group 3,910 passed, 1 skipped, 1 failed; the workspace, bridges, and Codex protocol lockfile groups all passed.
- **Isolated rerun:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` -> 20 passed, 0 failed, 93 assertions. The file is self-sufficient.
- **Hypothesis (evidence-backed, root cause not confirmed):** the two surplus tabs are not rendered by this dialog. `apps/web/src/components/settings/SkillsSettings.tsx:509-514` renders a `Tabs` with exactly `rendered` and `raw` triggers, and `tests/unit/components/SettingsPage.test.tsx` is the only file in the root group that mounts `SkillsSettings`. `--parallel` implies `--isolate`, so each file gets a fresh module registry and therefore a fresh Testing Library container registry — but `document.body` is shared by every file a worker process runs in sequence. A container left mounted by an earlier file is invisible to this file's `cleanup()` and still visible to `getAllByRole`, which queries the whole document. That makes the failure depend on which files happen to share a worker.
- **Reproduction attempts, all on 2026-08-13:**
  - `bun test tests --parallel` (the root group alone) -> 3 of 3 runs clean, 3,911 passed / 1 skipped / 0 failed each. The failure has so far appeared only under a full `bun run test`, where the root group runs concurrently with the workspace group's full web suite and the machine is far more loaded.
  - `bun test tests/unit/components/SettingsPage.test.tsx tests/unit/components/EnvironmentSettingsDialog.test.tsx` (both files, one process) -> 27 passed, 0 failed. Forcing the suspected pair together did not reproduce it, so file pairing alone is not sufficient.
  - `bun test tests/unit/components` (whole directory, single process) does reproduce this failure, **but that result is not evidence for this entry.** Without `--isolate` the run also triggers the `mock.module` cross-file leakage documented in `AGENTS.md`, cascading roughly twenty unrelated failures. Any future investigation must stay in `--parallel`/`--isolate` mode.
- **Next step:** capture which files shared the worker on a failing run rather than guessing the pairing, since the leak is scheduling-dependent and the obvious pair is already ruled out.
- **Do not** narrow the assertion to "contains" to make this pass: the test asserts the exact agent tab set, and a leaked container is a real isolation defect worth locating.

## `Electron tmux backend command registration` agent MCP config and hook tests (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/ork-fix-root-tests.log` on an 18-worker macOS host, run as validation for the unified agent picker change
- **Failure:** three tests in this file timed out or failed in one aggregate run — `does not create an agent MCP config when Claude lacks the launch flag` (790.79 ms), `writes an owner-only agent MCP config and includes it in a local Claude launch` (5,002.17 ms), and `generated blocking hooks use an integer timeout and fail closed on expiry` (5,006.26 ms). The two 5,000 ms durations are Bun's default per-test budget.
- **Suite counts:** root group 3,634 passed, 1 skipped, 4 failed, 3 errors across 143 files in 237.95 s.
- **Isolated rerun:** `bun test ./tests/unit/electron/tmux-backend.test.ts --parallel` -> 173 passed, 0 failed in 87.91 s. Evidence: `/tmp/ork-fix-tmux-isolated.log`.
- **Not covered by the no-`tmux` entry below:** `tmux 3.6a` is installed at `/opt/homebrew/bin/tmux` on this host and the root group ran in its normal time (237.95 s, not the ~1,035 s described there), so the documented environmental exclusion does not apply.
- **Non-determinism across runs:** an immediately preceding aggregate run of the same suite at commit `cb520049` failed a *different* three tests from this same file — `serializes stop behind an in-flight start so no tmux session is orphaned`, `keeps per-environment hook state under the shared runtime root and removes it on stop`, and `environment teardown kills live sessions, restores settings and removes the runtime root`. Which tests fail therefore varies between runs of the same code.
- **Hypothesis (not confirmed):** the file's per-test budget is exhausted under aggregate scheduling rather than any assertion being wrong; the isolated run needs 87.91 s for 173 tests, so several individual cases already sit close to 5,000 ms before contention. The log also carries `[tmux] --thinking-display probe failed; launching without it warn: spawn claude ENOENT`, so a host without the Claude CLI on `PATH` may be paying an extra spawn-failure cost in these launch paths. Neither has been isolated to a specific test.
- **Clean rerun of the whole group:** a later `bun test ./tests --parallel` on the same host and the same branch reported 3,638 passed, 1 skipped, 0 failed in 118.36 s, with none of these tests failing. The aggregate group therefore passes and fails non-deterministically on identical code.
- **Next step:** record whether the failing subset correlates with the worker a file lands on, and time the individual launch-path tests in isolation before deciding between a larger budget and a stubbed launcher.

## `process and platform command behavior > launches browser, file manager, and editors without a shell` (`tests/unit/electron/commands-process-coverage.test.ts`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/ork-fix-root-tests.log` on an 18-worker macOS host
- **Failure:** the test exceeded Bun's 5,000 ms budget (reported duration 5,002.42 ms) with no assertion message.
- **Suite counts:** root group 3,634 passed, 1 skipped, 4 failed, 3 errors across 143 files in 237.95 s.
- **Isolated rerun:** `bun test ./tests/unit/electron/commands-process-coverage.test.ts --parallel` -> 59 passed, 0 failed in 1.30 s; the whole file costs a fraction of this one test's aggregate budget. Evidence: `/tmp/ork-fix-process-isolated.log`.
- **Recurrence:** the same test also timed out at 5,004.51 ms in the preceding aggregate run at commit `cb520049`, so unlike the `tmux-backend.test.ts` entry above this one has repeated identically across two runs.
- **Recurrence (session-liveness review, 2026-08-14):** timed out again at 5,000.87 ms under `set -o pipefail; bun test ./tests --parallel` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host. Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 errors across 143 files in 212.53 s. The immediate isolated rerun passed all 59 tests. That is three identical timeouts across three separate aggregate runs, which strengthens the contention reading rather than an intermittent one. Evidence: `/tmp/rev-root-tests.log`, `/tmp/rev-isolated-commands-process-coverage.log`.
- **Hypothesis (not confirmed):** the test asserts that browser/file-manager/editor launches happen without a shell, so it waits on spawned child processes; under a loaded 18-worker run those spawns are contending with every other suite's children. The 1.30 s isolated cost makes an outright hang unlikely. Whether the wait is on process spawn or on a fake-binary lookup has not been established.
- **Clean rerun of the whole group:** a later `bun test ./tests --parallel` on the same host and branch reported 3,638 passed, 1 skipped, 0 failed in 118.36 s — half the wall time of the failing run (237.95 s) and with this test passing, which is consistent with contention rather than a defect in the test.
- **Next step:** instrument which awaited spawn is outstanding at timeout before changing the budget, since a raised budget would hide a genuine spawn regression here.
- **Related recurrence (2026-08-27):** the sibling `falls back to the parent
  directory when Linux FileManager1 fails` timed out at 5,001.17 ms in the
  four-worker root suite, left a dangling `xdg-open`, and passed in the combined
  117-test isolated rerun. Its assertions already name both expected launcher
  invocations, so it now carries an explicit outer budget while retaining the
  exact spawn sequence.

## Environmental, not flaky: `tests/unit/electron/*` on a host without `tmux`

- **Status:** environmental; not a product or test defect
- **Date observed:** 2026-08-07
- **Observation:** on a macOS host with no usable `tmux` binary, the root group takes roughly 1,035 s instead of its normal runtime and reports a handful of timeouts whose wall time is 900 s or more. Which tests fail varies between runs: `live session read paths > does not drop a back-to-back turn while the prior notification is pending`, `Electron backend command registry > backend-owned diff statistics > clears published counts when a repository config retarget cannot be scanned`, and `remote gateway > serializes invoke results once and keeps command metrics private and bounded` in one run; three different `tmux-backend`/`commands` tests in another.
- **Evidence:** the preceding output shows `spawn ... ENOENT` from `apps/backend/src/core/tmux.ts:331`. The affected files pass in isolation (`bun test tests/unit/electron/{tmux-backend,commands,backend-process,commands-io-coverage}.test.ts --parallel` -> 564 passed, 1 skipped, 0 failed in 66.95 s), and a fresh `origin/main` worktree reproduces the same shape, so this is not attributable to any working change.
- **Guidance:** do not record a new flake entry for these unless they fail on a host where `tmux` is installed and the root group runs in its normal time.

## Environmental, not flaky: the iOS group when two worktrees build concurrently

- **Status:** environmental; not a product or test defect
- **Date observed:** 2026-08-14
- **Observation:** `bun run test` on branch `missing-tool-calls` exited 65 with the iOS group as the only failing group. No Swift test ran and no test name is attributable — `xcodebuild` failed before the test bundle launched.
- **Evidence:** the failure is `unable to attach DB: error: accessing build database "/private/var/folders/.../T/orkestrator-mobile-test-derived/Build/Intermediates.noindex/XCBuildData/build.db": database is locked Possibly there are two concurrent builds running in the same filesystem location.`, followed by `Testing cancelled because the build failed.` and `** TEST FAILED **`. `scripts/test-ios.ts:15-16` defaults derived data to `$TMPDIR/orkestrator-mobile-test-derived`, a machine-global path shared by every worktree, and there are ~35 sibling worktrees under `~/orkestrator-v2/workspaces/`. An immediate isolated rerun of `bun run test:ios` passed: `Executed 40 tests, with 0 failures (0 unexpected) in 0.163 seconds`, `** TEST SUCCEEDED **`. The four JS/TS groups in the same aggregate all passed live with the Turbo cache cleared (13,910 passed, 13 skipped, 0 failed), and the change under test touches no iOS or Swift code.
- **Guidance:** do not record a new flake entry for an iOS group failure whose message is `database is locked`. Rerun `bun run test:ios` alone, and only investigate if it fails with no other build running against `$TMPDIR/orkestrator-mobile-test-derived`. A durable fix would give each worktree its own derived-data path.

## Environmental, not flaky: the root group while a `dev:test` profile is live

- **Status:** environmental; not a product or test defect
- **Date observed:** 2026-08-14
- **Observation:** `bun test ./tests --parallel` reported `3625 pass, 1 skip, 10 fail` in 179.8 s while an agent-testing profile (`dev:test --profile agent-model-picker-bullet`) was running its launcher, Vite, Electron, and backend on the same host. Every failure was a 5,000 ms timeout, spread across unrelated files: `process and platform command behavior` (`tests/unit/electron/commands-process-coverage.test.ts`, 2 tests), `Electron backend command registry` (`tests/unit/electron/commands.test.ts`, 2), `Electron tmux backend command registration` (`tests/unit/electron/tmux-backend.test.ts`, 2), `web-public install.sh` (`tests/unit/install-script.test.ts`, 2), `download-claude.sh` (`tests/unit/download-scripts.test.ts`, 1), and `Electron backend process supervisor` (`tests/unit/electron/backend-process.test.ts`, 1).
- **Evidence:** rerunning all six owning files together with no profile running passed cleanly — `bun test tests/unit/download-scripts.test.ts tests/unit/install-script.test.ts tests/unit/electron/commands.test.ts tests/unit/electron/tmux-backend.test.ts tests/unit/electron/commands-process-coverage.test.ts tests/unit/electron/backend-process.test.ts` -> 698 passed, 1 skipped, 0 failed. The tests spawn real child processes and assert against short fixed deadlines, so a concurrently supervised Electron stack starves them.
- **Guidance:** stop the `dev:test` profile before running a full suite, and do not record new flake entries for wall-clock timeouts observed while one is live. Only investigate if the same test times out on an otherwise idle host.

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

## `ActionBar workflow tabs > clears active long-press click suppression when the action bar unmounts` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the remaining workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** Testing Library could not find an accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2474` (duration: 628.67 ms).
- **Suite counts:** Web package: 4,808 total, 4,806 passed, 1 skipped, 1 failed across 210 files.
- **Isolated rerun:** `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel` -> 145 passed, 0 failed, 558 assertions in 15.95 seconds; the target passed in 587.91 ms.
- **Recurrence (attachment-only startup review, 2026-08-15):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-dfc3ad3f-full-tests.log` reproduced the identical signature — no accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2474` (duration: 608.50 ms) — with the web workspace package running alongside the root, bridge, and protocol-lockfile groups. Web package: 4,851 total, 4,849 passed, 1 skipped, 1 failed across 211 files; every other group passed and Turbo reported `11 successful, 12 total`. The immediate isolated rerun, `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx`, passed 145/0 with 558 assertions in 12.79 seconds. Evidence: `/tmp/orkestrator-review-dfc3ad3f-full-tests.log` and `/tmp/orkestrator-review-dfc3ad3f-actionbar-isolated.log`.
- **Hypothesis:** The aggregate-only result shows the expected long-press dialog was absent when queried, while the full owning file recreates it in isolation. Two occurrences now share the same line and a sub-second duration, so the long press is firing but the dialog has not mounted by the time the query runs — consistent with scheduling contention rather than a product failure. No narrower trigger is established; a further recurrence should capture the long-press timer, pointer events, and unmount/remount state before changing the product behavior or assertion.

## `ActionBar workflow tabs > opens the PR modal after a mobile long press without launching a default PR` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun --cwd=apps/web test --parallel=4`
- **Worker configuration:** The whole web package ran as one four-worker pool (216 files); the root, bridge, and protocol groups were not running concurrently.
- **Failure:** Testing Library could not find an accessible `dialog` named `Configure pull request` at `ActionBar.test.tsx:2586` after the fixed 575 ms long-press wait (duration: 735.93 ms; also observed at 741.62 ms and 747.05 ms).
- **Suite counts:** Web package: 4,928 passed, 1 skipped, 1 failed across 4,930 tests in 216 files. Reproduced on 3 of 6 aggregate runs; the other 3 runs passed 4,929/0.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` -> 156 passed, 0 failed in 18.68 s; the target passed every time.
- **Hypothesis:** This is the PR-modal twin of the code-review case resolved below, and it was the only long-press dialog assertion in the file still querying immediately after the fixed sleep instead of through `waitFor` (compare `ActionBar.test.tsx:2673` and `:2712`, both already wrapped). Under aggregate scheduling the 550 ms production timer can land after the 575 ms test sleep, so the query runs before the dialog mounts. The failure predates the change under which it was observed; it is a timing-sensitive assertion, not a product defect.
- **Root cause:** The assertion was made immediately after a fixed sleep instead of waiting for the timer-driven dialog state transition — identical to the resolved twin below, which was missed when that fix was applied.
- **Fix:** Wrap the `Configure pull request` dialog assertion in `waitFor` with a 10-second budget, matching the twin's remedy from commit `9065ed7f`.
- **Verification:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` -> 156 passed, 0 failed; the target completed in 660.98 ms. Two subsequent full web-package aggregates (`bun --cwd=apps/web test --parallel=4`) passed 4,929/0 across 216 files.

## `ActionBar workflow tabs > opens the review modal after a mobile long press without launching the default review` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-test.log`
- **Worker configuration:** The web workspace package ran its parallel test pool while the root, bridge, and Codex protocol-lockfile groups ran concurrently.
- **Failure:** Testing Library could not find the accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2407` after the 575 ms long-press wait (duration: 615.80 ms).
- **Suite counts:** Web package: 4,844 passed, 1 skipped, and 2 failed across 4,847 tests; the other failure was the deterministic AgentNativeTab context-wheel assertion.
- **Isolated rerun:** `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel` -> 145 passed, 0 failed, 558 assertions in 13.24 seconds; the target passed in 598.64 ms.
- **Hypothesis:** The test queried immediately after a real-time sleep, so aggregate scheduling could delay the 550 ms production timer beyond the fixed 575 ms test wait. The owning file passes in isolation, consistent with a timing-sensitive assertion rather than a product failure.
- **Root cause:** The assertion was made immediately after a fixed sleep instead of waiting for the timer-driven dialog state transition.
- **Fix:** Commit `9065ed7f`; wrap the dialog assertion in `waitFor` with a 10-second test budget.
- **Verification:** The owning file passed with 145 tests and 0 failures after the fix; the affected test completed in 620.53 ms. The subsequent `/tmp/orkestrator-final-full-test.log` aggregate passed workspace (4,846 tests), root/agent-support (3,656 tests), bridges, Codex protocol lockfile checks, and iOS (40 tests) with 0 failures.

## `UpdateCoalescer > re-reads a dynamic interval across schedules in both directions` (`bridges/codex-bridge/src/messages/coalescer.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` concurrently with the workspace, root, and protocol-lockfile groups.
- **Failure:** Expected `publishedAt` to contain 3 timestamps but received 4 at `coalescer.test.ts:90` (duration: 90.32 ms).
- **Suite counts:** Bridges: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files.
- **Isolated rerun:** `bun test ./bridges/codex-bridge/src/messages/coalescer.test.ts --parallel` -> 9 passed, 0 failed, 23 assertions in 268 ms; the target passed in 78.26 ms.
- **Hypothesis:** The test coordinates multiple real elapsed-time intervals and observed one additional publish only under aggregate scheduling. A deterministic scheduler or callback boundary should be evaluated if it recurs; the available evidence does not establish a production coalescing defect.

## `MobileAppShellLayout > closes the initial project drawer from its close button and restores trigger focus` (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `bun test --cwd apps/web src --parallel 2>&1 | tee /tmp/ork-review-web-suite.log`
- **Worker configuration:** The web package ran `bun test src --parallel` (18 workers) while two suites owned by other sessions ran concurrently in the same checkout: another full `bun test --cwd apps/web --parallel` and a root `bun test ./tests ... --parallel=4` observed at roughly 348% CPU.
- **Failure:** `this test timed out after 5000ms` (duration: 6,623.04 ms). No assertion failure was reported.
- **Suite counts:** Web package: 4,865 total, 4,862 passed, 1 skipped, 2 failed across 213 files with 15,071 assertions in 174.66 seconds. The other failure in that run, `AgentNativeTab > capability-driven parity > does not render a context wheel when the provider reports no maximum`, is not a flake and is deliberately not recorded here: it reproduces in isolation and is a real `expect(received).toBeNull()` failure present at commit `989f6c9d` but absent on `origin/main` at `f5961ebc`, so it is a branch-is-behind-main gap rather than nondeterminism.
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx` -> 24 passed, 0 failed; the affected case passed. A later full-suite run of the same tree also passed this case.
- **Pre-existing:** Unrelated to the reviewed PR-dialog change, which touches no drawer or sidebar code.
- **Hypothesis:** This case is the close-and-restore half of the split described in the resolved `MobileAppShellLayout > opens the project drawer on initial mobile entry and keeps workspace content mounted` entry above. That split gave each focus transition its own budget, and it held until three parallel suites shared one machine. The recurrence therefore looks like the same asynchronous Radix focus-restore boundary exceeding a 5,000 ms wall-clock budget under extreme contention rather than a return of the original shared-budget cause. Before raising the timeout, establish whether the restore awaits more than one animation frame.

## `QueuedPromptsDialog > moves entries within bounds and removes by id` (`apps/web/src/components/chat/QueuedPromptsDialog.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `bun test --cwd apps/web src --parallel 2>&1 | tee /tmp/ork-fix-web-suite-final.log`
- **Worker configuration:** The web package ran `bun test src --parallel` (18 workers) while suites owned by other sessions ran concurrently in the same checkout.
- **Failure:** Reported as `(fail)` at 1,034.74 ms. Bun's buffered output for this run interleaved another file's `act(...)` warnings immediately after the failure line, so no matcher message was retained.
- **Suite counts:** Web package: 4,873 total, 4,870 passed, 1 skipped, 2 failed across 213 files in 132.19 seconds. The other failure is the deterministic `AgentNativeTab` case described in the entry above, which is not a flake.
- **Isolated rerun:** `bun test --cwd apps/web src/components/chat/QueuedPromptsDialog.test.tsx` -> 12 passed, 0 failed.
- **Pre-existing:** Unrelated to the reviewed PR-dialog change, which touches no prompt-queue code. The same file passed in the immediately preceding full run of the same tree.
- **Hypothesis:** No matcher message survived, so no cause is established. A recurrence should be captured with the owning file run alone under `--parallel` so the failure message is not interleaved, before any assertion is weakened.

## `Files panel components > FilesPanel confirms actions and keeps failed actions open for retry` (`tests/unit/components/FilesPanel.test.tsx`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/rev-root-tests.log` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host
- **Worker configuration:** Root-only suite, `--parallel` (18 workers), run on its own rather than inside `bun run test`.
- **Failure:** the test exceeded Bun's 5,000 ms budget (reported duration 5,090.23 ms) with no assertion message.
- **Suite counts:** Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 between-test errors across 143 files in 212.53 s.
- **Isolated rerun:** `bun test ./tests/unit/components/FilesPanel.test.tsx --parallel` -> 22 passed, 0 failed, exit 0. Evidence: `/tmp/rev-isolated-filespanel.log`.
- **Hypothesis:** A bare timeout with no assertion text, in a happy-dom component test that drives a confirm-then-retry flow across several awaited state transitions. Nothing establishes which await was outstanding, and the whole owning file costs a fraction of this one test's aggregate budget in isolation, so contention is the leading reading. Instrument the outstanding transition before raising the budget — a raised budget would hide a genuine regression in the retry path.

## `web-public install.sh > uses the installed bun when the install leaves no bunx` (`tests/unit/install-script.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/rev-root-tests.log` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host
- **Worker configuration:** Root-only suite, `--parallel` (18 workers).
- **Failure:** timed out after 5,000 ms (reported duration 5,000.60 ms), and additionally reported `Expected: 0 / Received: 143` at `install-script.test.ts:161:29` — a non-zero shell exit from the script under test alongside the timeout.
- **Suite counts:** Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 between-test errors across 143 files in 212.53 s.
- **Isolated rerun:** `bun test ./tests/unit/install-script.test.ts --parallel` -> 11 passed, 0 failed, exit 0. Evidence: `/tmp/rev-isolated-install-script.log`.
- **Related:** a different case in the same file, `runs on both supported platforms`, is recorded separately above with two timeouts of its own. Both cases shell out to the real install script, so the file — not either individual case — is the likely unit of contention.
- **Hypothesis:** `143` is `128 + 15`, the conventional shell encoding of SIGTERM, which is consistent with the harness killing the spawned script when the 5,000 ms budget expired rather than with the script genuinely failing. On that reading the exit-code assertion is a downstream symptom of the timeout, not a second defect. This has not been confirmed by capturing the signal directly, and should be before the assertion is changed.
- **Recurrence in a sibling case (shared native-agent capability table, 2026-08-16):** `bun run test:logged -- --name full-suite -- bun run test` at `8136e45aea7db854a29338e4ce0b78513668e3ae` reported the same `Expected: 0 / Received: 143` signature for a third case in this file, `defaults BUN_INSTALL to ~/.bun` (`install-script.test.ts:168`), as an unhandled error between tests rather than as a reported case failure. The immediate re-run of the identical command did not reproduce it. This strengthens the "the file, not any individual case, is the unit of contention" reading in the **Related** note above: three separate cases in `install-script.test.ts` have now produced the SIGTERM exit code under aggregate load.

## `standalone backend service > drains an active local server process tree before exiting` (`apps/backend/tests/standalone.test.ts`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test --cwd apps/backend src tests --parallel 2>&1 | tee /tmp/rev-backend-tests-cwd.log`, at or immediately after `c4ce823fb218e0f858115c0e0ada81203998c10a`
- **Worker configuration:** Backend package only, `bun test src tests --parallel`, run on its own rather than inside `bun run test`.
- **Failure:** timed out after 5,000 ms (reported duration 5,001.55 ms) with no assertion message.
- **Suite counts:** Backend package: 1,696 total, 1,695 passed, 1 failed across 55 files in 37.02 s.
- **Isolated rerun:** `bun test --cwd apps/backend ./tests/standalone.test.ts` -> 8 passed, 0 failed in 35.48 s. Evidence: `/tmp/rev-isolated-standalone.log`.
- **Related:** a different case in the same file, `exits without a leftover listener when environment-managed Serve setup fails`, is recorded separately above. Both cases boot a real backend process and wait on its shutdown.
- **Hypothesis:** The test spawns a real local server process tree and waits for the drain to complete. The isolated file takes 35.48 s for 8 tests, so this suite is already near the budget per case without contention; a parallel backend run adds process-startup competition on top. A later run of the same command at the same head passed this case and failed a different backend test instead, which is consistent with a shared-resource race rather than a defect in the drain itself. Establish whether the outstanding wait is on process exit or on port release before adjusting the budget.

## `environment status and settings commands > preserves an admitted container start while its container is not yet persisted` (`tests/unit/electron/commands.test.ts:16388`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests.log`
- **Worker configuration:** The root and agent-support group ran concurrently with the workspace, bridge, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** `error: Timed out waiting for active start to finish` from the file's own `waitForCondition` helper (`commands.test.ts:1115`), reached through `withFakeGh` -> `withFakeDocker` (duration: 3,090.51 ms).
- **Suite counts:** Root and agent-support group: 3,657 total, 3,655 passed, 1 skipped, 1 failed across 145 files.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 89.34 seconds; the target passed.
- **Hypothesis:** The case drives fake `gh` and `docker` child processes and polls for the start to settle on a wall-clock budget, so it is contention-sensitive in the same way as the tmux clusters above. Observed while the only source change was in `bridges/acp-bridge`, which this test never loads. A recurrence should capture whether the admitted-start latch or only the poll budget was late before changing the command's behavior.

## `rate_limit_event > times out a non-settling structured request without blocking turn completion` (`bridges/claude-bridge/src/services/session-manager.test.ts:11606`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fixes2-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` alongside the workspace, root, and protocol-lockfile groups, while two unrelated agent sessions ran their own suites against the same clone. System load average was above 10 for the whole run.
- **Failure:** `expect(received).toBeGreaterThanOrEqual(expected)` at `session-manager.test.ts:11617` — expected `>= 950`, received `945` (duration: 1,002.35 ms). The turn itself behaved correctly: `StructuredUsageRequestTimeoutError: Structured usage control request timed out after 1000ms` was raised as designed and the session still settled to `idle`.
- **Suite counts:** Bridge group: 2,470 total, 2,458 passed, 11 skipped, 1 failed across 70 files in 37.80 seconds.
- **Isolated rerun:** `set -o pipefail; bun test bridges/claude-bridge/src/services/session-manager.test.ts` -> 397 passed, 0 failed in 9.18 seconds; the target passed. Evidence: `/tmp/ork-verify-session-manager.log.gz`.
- **Hypothesis:** Not the usual contention-makes-it-slower shape — the measurement came in 5 ms *under* the floor, so the failure is that a nominally 1,000 ms timer completed in 945 ms of `Date.now()` wall time. `startedAt` is captured before `runPromptWithMessages`, so the elapsed span strictly contains the timer and should never be shorter than it. That points at wall-clock versus timer-clock divergence (Bun schedules the timeout on a monotonic clock while the assertion measures `Date.now()`), which a loaded machine or an NTP slew can widen past the assertion's 50 ms lower tolerance. A recurrence should record whether the shortfall grows with load before the tolerance is widened; measuring the span with a monotonic source such as `performance.now()` would remove the coupling without weakening the upper bound.

## `ACP bridge > rejects a concurrent second turn that carries a different requestId` (`bridges/acp-bridge/src/index.test.ts:4956`)

- **Status:** resolved — see the 2026-08-16 resolution sweep above
- **Date observed:** 2026-08-15
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `5f1d23c525b47c2f0ed8ffc7b8d73cb951a5fad2` on `activate-agent-tab`.
- **Worker configuration:** The bridges group ran `bun test bridges --parallel` alongside the workspace, root, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded pools.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration 5,007.20 ms), thrown from the file's own `waitFor` helper (`index.test.ts:113`) as called by `spawnBridge` (`index.test.ts:158`) — that is, the spawned bridge child never reported healthy, not an assertion about the concurrent-turn behaviour under test.
- **Suite counts:** Bridges group: 2,538 total, 2,526 passed, 11 skipped, 1 failed across 70 files in 41.61 seconds.
- **Isolated rerun:** `bun run test:logged -- --name acp-isolated -- bun test bridges/acp-bridge/src/index.test.ts` -> exit 0, whole file passed in 29.9 seconds.
- **Related:** the resolved entry for `ACP bridge > settles Cursor's in-process child as finished` in the same file. That fix raised the file-wide test budget to 20 s while deliberately leaving `waitFor`'s own default at 5 s, so its diagnostic wins over Bun's generic timeout. This occurrence is that design working as intended: the 20 s budget was never reached because `spawnBridge`'s 5 s health wait expired first.
- **Hypothesis:** Same structural family as that entry — under aggregate spawn contention the bridge child needs longer than 5 s to bind and answer. The failing wait is health, not the behaviour under test, and the change in flight touched only `apps/backend/src/core/storage.ts` and `apps/web/src/components/terminal/TerminalContainer.tsx`, neither of which this file loads. A recurrence should record how long the child actually took to become healthy before `spawnBridge`'s health wait is raised, so the budget is set from measured startup latency rather than from the failure that happened to be observed.

## `Electron backend command registry > backend-owned diff statistics > invalidates the shared file-list cache after container revert and delete` (`tests/unit/electron/commands.test.ts:7090`)

- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `46a9fe2964af89ce4407b74ab223e0985426eff8` on `split-large-modules`.
- **Worker configuration:** The root and agent-support group ran `bun test tests --parallel=4` alongside the workspace, bridges, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** `error: Timed out waiting for container file to be cached again` from the file's own `waitForCondition` helper; failed duration 3,242.54 ms.
- **Suite counts:** Root and agent-support group: 3,705 total, 3,703 passed, 1 skipped, 1 failed across 147 files in 106.83 seconds. The workspace, bridges, and protocol-lockfile groups passed.
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts --test-name-pattern 'invalidates the shared file-list cache'` -> 2 passed, 0 failed in 724 ms; the target passed. A full root-group rerun (`bun test ./tests --parallel=4 --only-failures`) also passed, exit 0, in 109.3 seconds.
- **Root cause:** The same suppression race already diagnosed for the local-revert
  sibling below — see `invalidates the shared file-list cache after local revert
  and delete`. `revert_container_file` only *requests* its scan
  (`diffStatsService.refresh` is not awaited), so the reverted counts are not
  published when the command returns. This test restored the modified fixture to
  `FAKE_CONTAINER_MUTATION_RESPONSE` immediately afterwards. When the revert's
  scan then ran it read the restored fixture and produced `{additions: 1,
  deletions: 0, filesChanged: 1}` — identical to the pre-revert `entry.last` — so
  `DiffStatsService.run` returned at its `isSameStats` check without emitting
  *and without moving* `entry.last`. From that point every later scan compared
  equal and no scan could announce the rewrite, so the wait could only time out.
- **Why it survived the earlier fix:** the 2026-08-06 fix was applied only to the
  local variant. The container variant expresses the same sequence through a
  fake `docker exec` response file rather than a real worktree, so it did not
  match a text search for the local fix and kept the original interleaving.
- **Fix:** Wait for the reverted counts (`filesChanged === 0`) to be announced
  before restoring the modified fixture, so the restore is a genuine change
  rather than a no-op the service is right to swallow. The revert and delete
  assertions are unchanged.
- **Test budget:** the test now carries `ASYNC_TEST_BUDGET_MS`, matching the local
  variant. It awaits the wait helper twice, and without the budget two bounded
  3-second waits can exceed Bun's 5-second default and report a generic timeout
  instead of naming the condition that never became true.
- **Verification:** `bun test tests/unit/electron/commands.test.ts --test-name-pattern 'invalidates the shared file-list cache after container revert and delete' --rerun-each 25` -> 25 passed, 0 failed in 3.79 s.

## `ACP bridge > keeps a completed turn idle when Cursor replay is failed` (`bridges/acp-bridge/src/acp-transcript.test.ts:1410`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`, at `8f15f6c3f15dbe854c38b2f5b013b88d047f9d01` on `fix-todo-rendering`.
- **Worker configuration:** The bridges group ran on its own with `--parallel=2`, not under `scripts/test-all.ts`. No other suite was running against this clone.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration 15,023.19 ms), thrown from the shared `waitFor` helper (`acp-test-harness.ts:179`) as called by `spawnBridge` (`acp-test-harness.ts:228`). The wait that expired is `GET /global/health` against the freshly spawned bridge child, so the child never reported healthy; nothing about the completed-turn/failed-replay behaviour under test was reached.
- **Suite counts:** Bridges group: 2,607 total, 2,594 passed, 11 skipped, 2 failed, 1 error across 90 files in 62.25 seconds. The other failure and the error were not this flake: `acp-tools.test.ts` aborted at import because it was the first ACP test to load bridge source in-process and `ACP_PROVIDER` is only set for spawned children. That is deterministic, not flaky, and is fixed in the same change by `src/testing/unit-test-env.ts`.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-transcript.test.ts` -> 68 passed, 0 failed in 17.86 seconds; the target passed.
- **Frequency:** failed on two consecutive runs of the same command at `8f15f6c3`, then passed on a third run of the same command at the follow-up commit (47.3 seconds, exit 0). So it is intermittent rather than reliably reproducible, but more frequent than the single-shot spawn timeouts recorded above.
- **Related:** `ACP bridge > rejects a concurrent second turn that carries a different requestId`, the same `spawnBridge` health-wait family in `index.test.ts`. That entry was recorded when `BRIDGE_STARTUP_TIMEOUT_MS` was 5 s; the constant is now 15 s, so this occurrence means a bridge child took longer than fifteen seconds to bind and answer `/global/health`.
- **Hypothesis:** Spawn contention again, but the 15 s budget makes plain contention a weaker explanation than it was at 5 s — this file alone spawns a bridge child per test and several tests spawn twice (create, stop, respawn against the same state directory). A recurrence should record how long the child actually took to become healthy, and whether a previous test's child was still shutting down and holding its state directory or port, before the startup budget is raised again. Raising the budget without that measurement would hide a genuine startup regression.

## `ActionBar toolbar interactions > runs commands and opens the editor from keyboard shortcuts` (`apps/web/src/components/layout/ActionBar.test.tsx:1704`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, on `native-composer-capabilities` (working tree: composer capability gating).
- **Worker configuration:** Workspace web group under `scripts/test-all.ts`, with the root, bridge, and protocol-lockfile groups running concurrently.
- **Failure:** `expect(createTabMock).toHaveBeenCalledWith("plain", { initialCommands: ["bun test"] })` -> "But it was not called", after 68.27 ms. The two `fireEvent.keyDown(window, …)` dispatches on the preceding lines (`Cmd+P`, `Cmd+O`) are synchronous and unwaited, so nothing in the test gives the shortcut handler a chance to run before the assertion.
- **Suite counts:** Web package: 1 failed; every other workspace package reported `0 fail`. The immediately preceding aggregate run of the same command passed the whole web group, and the immediately following one did too.
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx -t 'runs commands and opens the editor from keyboard shortcuts'` -> 1 passed, 0 failed in 528 ms.
- **Frequency:** failed in 2 of 4 consecutive `bun run test` runs on the same commit; passed in the other 2 and in every isolated rerun. The second occurrence (89.77 ms) shared a run with a batch of 5,000 ms Electron timeouts caused by *another worktree's* live `dev:test` profile (see "Environmental, not flaky: the root group while a `dev:test` profile is live"). This failure is **not** that signature — it fails in under 100 ms rather than exhausting a deadline — so host load may make it likelier without being the mechanism. A final `bun run test` on an idle host passed in 93.5 s.
- **Hypothesis:** Same load-sensitive family as the three resolved `ActionBar` entries above, but the mechanism looks different: those timed out against Testing Library's default wait, whereas this one asserts synchronously on a mock immediately after `fireEvent.keyDown`. If the shortcut handler's effect subscription had not committed when the events were dispatched, the mock is legitimately never called and no amount of waiting inside the current assertion would help. A recurrence should check whether the handler is registered in a `useEffect` that had not flushed, and if so wrap the assertion in a bounded `waitFor` **and** confirm the listener is attached before dispatching, rather than only widening a timeout.
- **Unrelated to the change under test:** `ActionBar` does not read `nativeAgentCapabilities`, the native composer projection, or any of the composer control paths modified in this branch.

## `ActionBar workflow tabs > opens the Resolve modal after a mobile long press without launching a default resolve` (`apps/web/src/components/layout/ActionBar.test.tsx:2910`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-16
- **Original command:**
  `bun run test:logged -- --name web-all -- bun --cwd=apps/web test --parallel=4 --only-failures`,
  at `a9107f112ffe2642388c0279aada5c8430019e7c` on `unify-agent-components`.
- **Worker configuration:** four Bun workers on the web package alone, not under
  `scripts/test-all.ts`. An isolated `dev:test` profile (Electron, Vite, backend,
  bridges) had been running on this host earlier in the same session, so host
  load was above a quiet single-suite run.
- **Failure:** `getElementError` from `tests/bounded-test-diagnostics.ts:28`,
  raised at `ActionBar.test.tsx:2933` — the
  `screen.getByRole("dialog", { name: "Configure conflict resolution" })`
  assertion found no dialog. Duration 736.72 ms.
- **Suite counts:** `5095 pass, 1 fail. Ran 5096 tests across 221 files. [53.17s]`
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar --parallel=2`
  → exit 0, no failures. The aggregate command had also passed twice earlier in
  the same session at the same commit.
- **Recurrence (retry-gate review follow-up, 2026-08-25):** `bun run test` on
  `environment-log-flood` failed this case after 712.65 ms, now reported at
  `ActionBar.test.tsx:3041` with the same `getElementError` from
  `tests/bounded-test-diagnostics.ts:28`. It failed in the same run as
  `ActionBar keyboard shortcuts and tab guards > dispatches tab, workflow,
  editor, and panel shortcuts`; web workspace group 5,393 passed, 1 skipped,
  2 failed across 233 files. The isolated rerun
  `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` passed
  189/189 in 14.54 s. Consistent with the hypothesis below: the bare
  `setTimeout(575)` has no margin left once the whole file is running behind.
- **Recurrence (backend environment naming, 2026-08-27):** `bun run test`
  (`scripts/test-all.ts`, four top-level groups concurrently; web package at two
  workers) failed this case after 620.13 ms at `ActionBar.test.tsx:3161` with
  the same missing `Configure conflict resolution` dialog. The web package
  reported 5,531 passed, 1 skipped, and 1 failed across 242 files; the other
  three top-level groups passed. The immediate isolated rerun,
  `bun test src/components/layout/ActionBar.test.tsx` from `apps/web`, passed
  198/198 with 770 assertions in 14.10 s; the target passed in 612.04 ms. The
  environment-naming change does not touch `ActionBar`, its long-press timer, or
  conflict-resolution launch state.
- **Hypothesis:** the same wall-clock race already documented and fixed for
  `clears active long-press click suppression when the action bar unmounts`
  above. The case fires a touch `pointerDown`, sleeps a bare
  `setTimeout(575)` — the entire margin over the component's long-press
  threshold — then asserts synchronously. Under contention the timer fires late
  or React commits the dialog after the sleep resolves, and the immediate
  `getByRole` misses it. The documented fix for the sibling case (wait for the
  accessible dialog with a bounded UI wait instead of sleeping past the
  threshold) applies unchanged here; this occurrence is a second instance of the
  same pattern in a case the earlier sweep did not convert. Nothing in the
  failing path touches the transcript, agent cards, or background tasks, which
  are the only areas the change that observed this touched.

## Electron command-registry fixture-shim timeouts (four tests, three files)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Tests:**
  - `Electron backend command registry > rolls back a local rename when push configuration fails` (`tests/unit/electron/commands-registry-environments.test.ts:1667`, assertion at `:1672`)
  - `Electron backend command registry > advances the stored branch when a local rollback fails and the new branch is the only one left` (`tests/unit/electron/commands-registry-environments.test.ts:1709`, assertion at `:1717`)
  - `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-terminal.test.ts:1408`, assertion at `:1418`)
  - `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts:634`, assertion at `:650`)
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`, at `19a1001123b16a89e2a09324a0033ae9b26eb74f` on `agent-jsonl-acp`.
- **Worker configuration:** The root group ran on its own with `--parallel=4`, not under `scripts/test-all.ts`. No other suite was running against this clone.
- **Failure:** all four are Bun's generic `this test timed out after 5000ms`, at 5,004.99 ms, 5,004.18 ms, 5,002.52 ms and 5,017.16 ms respectively. Each is accompanied by an "Unhandled error between tests" block showing its fixture shim was already gone when the command finally ran:
  - the two environments cases logged `[ElectronBackend] Failed to rename local git branch: CommandFailedError: Command failed: git -C /var/folders/.../ork-electron-rename-repo-<suffix> branch -m -- old-branch review-oauth-flow`, then a post-timeout `git ... branch --show-current` against a temp repo directory that had already been torn down;
  - the terminal case reported `expect(received).toThrow(expected)`, expected substring `"Malformed"`, received `"Command failed: docker exec container-1 bash -lc ..."` (the full `get_git_status` script), i.e. the fake `docker` shim was no longer on `PATH`;
  - the PR case reported `Expected promise that resolves / Received promise that rejected` at `commands-registry-pr.test.ts:650`, inside `withFakeGh` (`tests/unit/electron/command-fixtures.ts:1212`).
- **Suite counts:** 3,724 passed, 1 skipped, 4 failed, 4 errors, 16,581 `expect()` calls; 3,729 tests across 178 files in 361.24 seconds. The four errors are the four "Unhandled error between tests" blocks above. The bridges group and the web, backend, desktop and acp-bridge typechecks all passed in the same validation round.
- **Isolated rerun:** each owning file passed alone — `bun run test:logged -- --name rerun-env-alone -- bun test tests/unit/electron/commands-registry-environments.test.ts` -> exit 0 in 34.4 s; `... commands-registry-terminal.test.ts` -> exit 0 in 28.7 s; `... commands-registry-pr.test.ts` -> exit 0 in 34.8 s.
- **Follow-up:** the identical whole-group command passed on a rerun later the same day, exit 0 in 161.9 s — under half the failing run's 361.24 s. The wall-clock gap is the useful part of that observation: the failing run was roughly 2.2x slower overall, which is consistent with host contention rather than with anything specific to these four cases.
- **Related:** the "Command-registry Git fixture, deduplicated/admitted container starts, and process-launch coverage" row of the 2026-08-16 resolution sweep. That sweep raised the shared condition deadline to 10 s and gave several cases explicit budgets precisely because the shared helper's deadline had grown past Bun's 5 s default. These four cases wait on real `git`/`docker`/`gh` shims but carry **no** `ASYNC_TEST_BUDGET_MS`, so Bun's 5 s default still wins and reports a generic timeout instead of naming the condition.
- **Hypothesis:** Same family as that sweep row rather than a new product defect — the change in flight touched only `bridges/acp-bridge`, which none of these files load. Under `--parallel=4` the real `git`/`docker`/`gh` shim processes under `$TMPDIR` are slow enough to exceed the 5 s outer budget; the timeout then interrupts the case mid-flight and its `finally` tears the shim down, which is what produces the trailing "command failed"/"promise rejected" errors *after* the timeout rather than before it. The log also shows repeated "killed 1 dangling process" lines around them. A recurrence should record how long the shim command actually took before any budget is raised: give each of the four an explicit `ASYNC_TEST_BUDGET_MS` so the named condition wins the race and the real latency is visible, rather than widening a tolerance against a generic timeout.
- **Recurrence (2026-08-27):** `verifies a PR against the trusted project and
  environment branches` timed out at 5,021.86 ms in the four-worker root suite
  and then passed with its owner in isolation. It uses the same real `gh` shim
  and teardown boundary, so it now carries `ASYNC_TEST_BUDGET_MS` without
  changing its repository, canonical-URL, head-branch, or base-branch checks.
- **Recurrence (terminal case only), 2026-08-17:** `rejects malformed container
  status framing and invalid encoded sections` failed alone under
  `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
  at `55539f08ac3dcb3b4b9e18e522f881e9992f9057` on `unify-agent-components`, four
  Bun workers on the root suite alone, with the bridges and web suites run back
  to back in the same session. Same two symptoms as above in the same order —
  `expect(received).toThrow(expected)` at `:1418`, expected substring
  `"Malformed"`, received `Command failed: docker exec container-1 bash -lc …`
  (the git-status script echoed back), then a 5,019.09 ms timeout and one
  trailing "Unhandled error between tests" for the same case. Suite counts:
  `3727 pass, 1 skip, 1 fail, 1 error. Ran 3729 tests across 178 files. [379.1s]`
  — again roughly 2.2x the passing run's wall clock. Isolated rerun
  `bun run test:logged -- --name root-terminal-isolated -- bun test tests/unit/electron/commands-registry-terminal.test.ts`
  → exit 0 in 31.7 s, and the same aggregate command passed at the follow-up
  commit in the same session (79.6 s, exit 0). The change in flight touched only
  the chat transcript, agent cards and background tasks, none of which this path
  loads. One alternative worth ruling out when the measurement above is taken:
  the received message is the *unrejected* command failure rather than the
  framing error, which would also fit the queued `docker` stub answering a
  different invocation than the one under test — an ordering dependency between
  queued fakes rather than plain shim latency. The isolated file takes 31.7 s in
  total with no single case near 5 s, so recording which stubbed command actually
  answered distinguishes the two before any budget is raised.

## `ACP bridge > bounds remembered provider message ids during a large replay` (`bridges/acp-bridge/src/acp-transcript.test.ts:136`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at
  `5b9c6e68` on `investigate-sub-agent`, with an uncommitted codex-bridge
  sub-agent-status change in the tree.
- **Worker configuration:** the full concurrent cross-platform suite via
  `scripts/test-all.ts`, so the bridges group ran alongside the root, web and
  protocol groups rather than on its own. Production Orkestrator was also live on
  this host (its Electron, backend, and per-environment claude/codex bridge
  children), so host load was well above a quiet single-group run.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration
  15,021.46 ms), thrown from the shared `waitFor` helper
  (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`) at
  `acp-transcript.test.ts:137`. The expired wait is the `GET /global/health` poll
  against the freshly spawned bridge child, so the child never reported healthy
  and none of the replay-bounding behaviour under test was reached.
- **Suite counts:** bridges group `2678 pass, 11 skip, 1 fail, 8904 expect() calls.
  Ran 2690 tests across 92 files. [67.00s]`. It was the only failure in the run.
- **Isolated rerun:** `bun run test:logged -- --name acp-transcript-alone -- bun test bridges/acp-bridge/src/acp-transcript.test.ts`
  → exit 0 in 18.1 s; the target passed. The same file had also passed earlier in
  the same session under `bun test bridges --parallel=2 --only-failures`
  (bridges group green in 49.2 s).
- **Related:** same `spawnBridge` health-wait family as
  `ACP bridge > keeps a completed turn idle when Cursor replay is failed`
  (`acp-transcript.test.ts:1410`) and
  `ACP bridge > rejects a concurrent second turn that carries a different requestId`
  (`index.test.ts:4956`). This is the first recurrence in this family recorded
  from a full `test-all.ts` run rather than a bridges-only run.
- **Hypothesis:** spawn contention, with this occurrence adding the evidence the
  `:1410` entry asked for on the load axis — the whole file takes 18.1 s alone
  while a *single* child startup exceeded 15 s here, so the budget was missed by
  a wide margin under four-group concurrency plus a live production instance,
  not marginally. It still does not measure how long the child actually took to
  bind, which remains the measurement needed before `BRIDGE_STARTUP_TIMEOUT_MS`
  is raised again; the open question from `:1410` — whether a prior test's child
  was still shutting down and holding its state directory or port — is also
  untested here. Note this file spawns a bridge child per test, and the change in
  flight touched only `bridges/codex-bridge` sub-agent status derivation, which
  no ACP path loads.

## `ACP bridge > starts local-default Cursor ACP without project MCP auto-approval` (`bridges/acp-bridge/src/acp-prompt.test.ts:50`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`,
  at `d70f1ac7` on `investigate-sub-agent`, with a clean tree.
- **Worker configuration:** the bridges group alone on two Bun workers — not the
  four-group `scripts/test-all.ts` run, and with no live production Orkestrator
  on the host. This is the quietest configuration in which this family has been
  recorded.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration
  15,011.97 ms), thrown from the shared `waitFor` helper
  (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`),
  reached through `readAgentArgs` (`acp-prompt.test.ts:25`) at
  `acp-prompt.test.ts:50`. As with the rest of this family the expired wait is
  the `GET /global/health` poll against the freshly spawned bridge child, so the
  child never reported healthy and none of the agent-argument behaviour under
  test was reached.
- **Suite counts:** bridges group `2679 pass, 11 skip, 1 fail, 8906 expect() calls.
  Ran 2691 tests across 92 files. [64.3s]`. It was the only failure in the run.
- **Isolated rerun:** `bun run test:logged -- --name acp-prompt-solo -- bun test bridges/acp-bridge/src/acp-prompt.test.ts`
  → exit 0 in 3.7 s; the target passed.
- **Related:** same `spawnBridge` health-wait family as
  `ACP bridge > bounds remembered provider message ids during a large replay`
  (`acp-transcript.test.ts:136`),
  `ACP bridge > keeps a completed turn idle when Cursor replay is failed`
  (`acp-transcript.test.ts:1410`) and
  `ACP bridge > rejects a concurrent second turn that carries a different requestId`
  (`index.test.ts:4956`).
- **Hypothesis:** the load explanation the `:136` entry offers does not cover
  this occurrence, and that is the new evidence here. The whole file passes alone
  in 3.7 s, yet one child startup exceeded 15 s with only one sibling worker and
  no competing group or production instance — so contention on the host cannot be
  the whole story, and raising `BRIDGE_STARTUP_TIMEOUT_MS` would not be justified
  by a 4x miss at this load. That points at the shared suspicion the `:1410`
  entry already raised rather than at throughput: a prior test's child still
  shutting down while holding its state directory or port, which would stall a
  fresh spawn regardless of how quiet the host is. The measurement this family
  still needs is unchanged — record how long the child actually took to bind, and
  whether a previous child was still alive when the failing spawn began, before
  any budget is touched. The change in flight touched only
  `bridges/codex-bridge` sub-agent status derivation, which no ACP path loads.

## `ACP bridge > keeps each assistant message on the model that produced it when the model changes` (`bridges/acp-bridge/src/acp-transcript.test.ts`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `3773514b` on `claude-task-layout`, with a working tree carrying web-only transcript-pinning changes.
- **Worker configuration:** the full four-group `scripts/test-all.ts` run, so the bridges group shared the host with the workspace, root and protocol groups. This is the loudest configuration in which this family has been recorded.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration 15,011.46 ms), thrown from the shared `waitFor` helper (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`). As with the rest of the family the expired wait is the `GET /global/health` poll against the freshly spawned bridge child, so the child never reported healthy and none of the per-message model attribution under test was reached.
- **Suite counts:** bridges group `2690 pass, 1 fail`. It was the only failure in that group; the root group's one failure in the same run was a real expectation change, not a flake.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-transcript.test.ts` → 69 passed, 0 failed; the target passed.
- **Related:** same `spawnBridge` health-wait family as `ACP bridge > bounds remembered provider message ids during a large replay` (`acp-transcript.test.ts:136`), `ACP bridge > keeps a completed turn idle when Cursor replay is failed` (`acp-transcript.test.ts:1410`), `ACP bridge > reads agent arguments from the spawned child` (`acp-prompt.test.ts:50`) and `ACP bridge > rejects a concurrent second turn that carries a different requestId` (`index.test.ts:4956`).
- **Hypothesis:** no new evidence, and this occurrence is the load-side complement to the `acp-prompt.test.ts:50` entry: that one missed the 15 s budget on the quietest configuration, this one missed it on the busiest, which is consistent with the family being dominated by something other than host throughput. The change in flight was confined to `apps/web` transcript rendering and `docs/`; no ACP path loads any of it, and `bridges/` was untouched. The outstanding measurement is unchanged — record how long the child took to bind and whether a previous child was still alive when the failing spawn began, before the startup budget is touched.

## `remote gateway > returns 502 and releases admission when an eligible buffered proxy body aborts` (`tests/unit/electron/gateway-proxy.test.ts:810`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `3773514b` on `claude-task-layout`, with a working tree carrying web-only transcript-pinning changes plus this document.
- **Worker configuration:** the full four-group `scripts/test-all.ts` run, so the root group shared the host with the workspace, bridges and protocol groups.
- **Failure:** the status assertion passed — the proxy did answer `502` — and the *body* assertion failed: `expect(received).toContain("aborted")`, received `{"error":"The socket connection was closed unexpectedly. For more information, pass \`verbose: true\` in the second argument to fetch()}`. So the abort was handled and admission released as intended; what varied is whether the client read the gateway's own error body or Bun's fetch-level socket-closed message first. Duration 64.71 ms, so this is a race in the read, not a timeout.
- **Suite counts:** root group `3772 pass, 1 fail. Ran 3774 tests across 181 files. [115.24s]`. It was the only failure in the group and in the whole run.
- **Isolated rerun:** `bun test tests/unit/electron/gateway-proxy.test.ts` → 26 passed, 0 failed, exit 0; the target passed.
- **Related:** same file as `remote gateway > keeps a slow but progressing proxy body alive past the idle timeout` (`gateway-proxy.test.ts:674`), and the same aggregate-only pattern recorded for that entry. Different mechanism, though: that one is a timing miss on a keep-alive, this one is a body-versus-socket-close read race on a deliberate abort.
- **Hypothesis:** the test aborts the upstream body and then asserts on both the status and the response text. When the abort lands before the gateway's error body is flushed and read, Bun's fetch surfaces its own socket-closed JSON instead, so the assertion sees a different — but equally correct — 502 body. The behaviour under test (502 plus admission release) was not violated in this run. Before touching the gateway, a recurrence should establish whether the assertion should accept either body shape, or whether the gateway should be made to flush its error body before the socket closes; the change in flight was confined to `apps/web` transcript rendering and `docs/`, and loads no gateway code.
## `useVirtuosoScrollState > scroll state persistence > keeps retrying until the Virtuoso handle is ready while the scroller stays mounted` (`tests/unit/hooks/useVirtuosoScrollState.test.ts:1576`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run immediately after a full `apps/web` suite and a bridge suite on the same host.
- **Failure:** reported only as a failing case in the run's compressed artifact (`root-tests.log.gz`); duration 65.08 ms. Suite counts for that run were not captured before the artifact rotated.
- **Isolated rerun:** `bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts` → 75 passed, 0 failed, run five consecutive times. A subsequent full `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures` also passed (3,767 passed, 0 failed, 166.5 s).
- **Attribution:** observed while `useVirtuosoScrollState.ts` was under change (persisted-snapshot validation). That change is inert for this case: the added code runs only inside the `persistKey` branch of the mount-time `useState` initializer, and this test constructs the hook without a `persistKey`, so it returns `undefined` exactly as before. The failing behaviour is the activation-retry loop, which the change does not touch.
- **Hypothesis:** the case asserts the retry loop after a single fixed `setTimeout(…, 30)`, having arranged for the Virtuoso handle to arrive on the 4th readiness read. Those reads are driven by `requestAnimationFrame` through `schedulePendingActivationScroll`, so the 30 ms budget only holds while happy-dom's rAF stays near-instant; under host contention four frames can exceed it and the assertion runs before the handle is ever read as ready. A recurrence should wait on the observable condition (poll until `reads > READY_AFTER`, or until `scrollToIndexCalls` is non-empty) instead of a fixed delay, rather than enlarging the 30 ms, which only moves the same race.

## `ACP bridge > omits model attribution entirely when the agent advertises no model` (`bridges/acp-bridge/src/acp-session.test.ts:156`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-18
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `5a5797eb` on `add-playwright-docker`, with a working tree carrying the Docker/Playwright review fixes (`docker/`, `apps/backend/src/core/commands-containers.ts`, `tests/unit/version-drift.test.ts`, `e2e/`, `AGENTS.md`).
- **Worker configuration:** the full four-group `scripts/test-all.ts` run, so the bridges group shared the host with the workspace, root and protocol groups.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration 15,021.82 ms), thrown from the shared `waitFor` helper (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`) at `acp-session.test.ts:156`. The expired wait is the `GET /global/health` poll against the freshly spawned bridge child, so the child never reported healthy and no model-attribution behaviour was reached. `describeWaitValue` printed `false` with no `(last error: …)` suffix, so every poll got an answer — the child was reachable and simply never reported healthy, rather than the socket being refused.
- **Suite counts:** bridges group `2701 pass, 11 skip, 1 fail. Ran 2713 tests across 92 files. [65.50s]`. It was the only failure in that group and in the whole run; the workspace, root/agent-support and codex-protocol-lockfile groups all exited 0.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-session.test.ts` → 13 passed, 0 failed, 52 `expect()` calls, 2.16 s. A logged rerun (`--name acp-session-alone`) also passed in 2.3 s, and a full `bun run test` rerun immediately afterwards passed in 72.7 s.
- **Related:** same `spawnBridge` health-wait family as `ACP bridge > keeps each assistant message on the model that produced it when the model changes` (`acp-transcript.test.ts`), `ACP bridge > bounds remembered provider message ids during a large replay` (`acp-transcript.test.ts:136`), `ACP bridge > keeps a completed turn idle when Cursor replay is failed` (`acp-transcript.test.ts:1410`), `ACP bridge > reads agent arguments from the spawned child` (`acp-prompt.test.ts:50`) and `ACP bridge > rejects a concurrent second turn that carries a different requestId` (`index.test.ts:4956`). This is the first member recorded in `acp-session.test.ts`, which widens the family from three files to four and further weakens "one slow file" as an explanation.
- **Attribution:** the change in flight is confined to the Docker image, the container `docker create` argv, `tests/unit/version-drift.test.ts`, an opt-in Playwright e2e case, and docs. No ACP path imports any of it, `bridges/` was untouched, and the whole file passes in 2.16 s against the same tree.
- **Hypothesis:** no new evidence beyond the widened file set, and the missing `(last error: …)` suffix is a small addition: the child's HTTP listener was up while its health state stayed `false` for the full 15 s, which points away from a slow spawn or a busy port and towards the child stalling after binding. The outstanding measurement for this family is unchanged — record how long the child took to bind and whether a previous child was still alive when the failing spawn began, before the startup budget is touched.

## `FeaturesView` owning-file worker crash (`tests/unit/components/FeaturesView.test.tsx`)

- **Status:** open — targeted stress has not identified a root cause or fix
- **Date observed:** 2026-08-18
- **Original command:** `bun run test:logged -- --name full-tests-rebased -- bun run test`, at `8c1dc1f3` on `questions-ui-layout` after rebasing the web-only native-agent question change onto `origin/main`.
- **Worker configuration:** the full four-group `scripts/test-all.ts` run; the root and agent-support group used six parallel Bun workers while sharing the host with the workspace, bridges, and protocol-lockfile groups.
- **Failure:** Bun reported `tests/unit/components/FeaturesView.test.tsx (worker crashed: SIGTERM)` without an assertion failure or individual test duration. The root and agent-support group finished in 85.13 s.
- **Suite counts:** root and agent-support group `3741 pass, 1 skip, 1 fail, 16681 expect() calls. Ran 3743 tests across 181 files.` The workspace, bridges, and protocol-lockfile groups all passed.
- **Isolated rerun:** `bun run test:logged -- --name features-view-isolated -- bun test tests/unit/components/FeaturesView.test.tsx --only-failures` → passed in 2.7 s.
- **Attribution:** the change in flight touches native-agent and chat-shell components plus their tests; it does not touch `FeaturesView`, its tests, or their dependencies. The isolated owner passed against the same immutable head.
- **Hypothesis:** the evidence establishes an aggregate-only worker termination, but not why the worker received `SIGTERM`. A recurrence should capture the runner's process/resource diagnostics and the test reached immediately before termination before changing test budgets or assertions.

## CreateEnvironmentDialog compact agent controls default mode (`tests/unit/components/CreateEnvironmentDialog.test.tsx`)

- **Status:** resolved — see the 2026-08-27 resolution sweep below
- **Date observed:** 2026-08-26
- **Original command:** `bun test apps/backend/src/core/extension-discovery.test.ts bridges/acp-bridge/src/grok-runtime.test.ts apps/desktop/electron/agent-platform-selection.test.ts tests/unit/electron/toolchain-startup.test.ts tests/unit/electron/commands-registry-tools.test.ts tests/unit/components/CreateEnvironmentDialog.test.tsx tests/unit/components/EnvironmentSettingsDialog.test.tsx`
- **Worker configuration:** one Bun test process running seven explicitly selected files.
- **Failure:** `resolveAgentDefaults > shows the project name in the title and presents the compact agent controls in order` expected the Use TUI checkbox `data-state` to be `unchecked`, but received `checked` (duration: 18.29 ms).
- **Suite counts:** 179 total, 178 passed, 1 failed.
- **Isolated rerun:** `bun test tests/unit/components/CreateEnvironmentDialog.test.tsx` → 105 passed, 0 failed in 5.62 s.
- **Hypothesis:** the result depends on state shared with another file in the combined Bun process; the owning file resets enough state to pass in isolation, but the exact leaking state has not been identified.

## 2026-08-27 resolution sweep

This sweep resolves only entries with an identified cause, a concrete fix, and
focused verification. The unattributed NativeAgent and FeaturesView incidents
remain open. Aggregate validation after the initial sweep exposed further
process-contention recurrences; the updated fixes subsequently passed the
complete concurrent suite. “This change” is the fix reference for the rows
below.

| Entries | Root cause | Fix | Verification |
| --- | --- | --- | --- |
| Multi Review address restart and missing-session activity | The tests treated the persisted workflow transition as if the derived environment activity write had completed in the same operation. `save()` deliberately persists the workflow first and then projects its activity, so aggregate scheduling could expose the durable terminal workflow during that short projection window. | Wait for both authoritative snapshots: the terminal/pending workflow condition and `agentActivitySources.multi-review === idle`. The missing-session case that failed the initial full run was fixed at the same boundary. | The owner passed 79/79 in isolation, then 237/237 across three repetitions while the ACP, root, and web stress groups ran concurrently. |
| OpenCode circular tool-payload fallback | The deliberately circular value drives the serializer's exception/fallback path; under a saturated host it exhausted Bun's generic outer test budget even though the fallback result was correct. | Give this CPU-bound exceptional-path case an explicit 30-second outer budget without changing either assertion. | The owner passed as part of a concurrent two-file web run: 252 tests, 893 assertions, zero failures. |
| ACP startup/readiness family: overflow, persistence quarantine, replay bounds/status/model attribution, and local-default prompt | The shared `afterEach` sent `SIGTERM`, immediately forgot every child, and deleted its state directories without awaiting exit. Bridge-heavy files therefore accumulated children still shutting down while later cases spawned more processes; cleanup could also race a child's final state access. | Materialize the child set, await `stopChild` for every process, delete each child from tracking in `finally` even when it already exited, and only then delete temporary directories. | A focused harness regression covers live and already-exited children plus fixture-deletion ordering. The final two-worker bridge run passed 3,152 tests, skipped 11, and failed zero. |
| Pi ACP settled-child re-adoption | `/activity` becoming `working` and the transcript projecting the new child card are separate asynchronous updates. Checking only arrival allowed a wrongly re-adopted card's transient active state to pass. | Poll for arrival, then require `working` activity and an active `cursor-subagent-2` card to persist across more than one complete background-discovery cycle. | The focused ACP run passed 35 tests with 164 assertions. |
| Gateway slow-progress and buffered-abort cases | The slow-progress fixture left only a 3:1 gap-to-timeout ratio, so host starvation could legitimately make one test-produced gap look idle. On deliberate abort, Bun can surface several socket-close messages. | Use a 25:1 progress-to-idle margin while keeping total transfer time beyond the idle deadline. Require the abort body to match a known abort/socket-close error, plus 502 and successful compressed recovery. | Included in the focused 293-test root/UI run with zero failures. |
| ActionBar keyboard shortcuts and Resolve long press | Shortcut cases could dispatch before the async Run control was enabled; the current test now waits for that accessible control before key events. The Resolve case slept just past the long-press threshold and synchronously queried before React necessarily committed the dialog. | Keep the shortcut readiness boundary and replace the Resolve dialog's immediate query with the bounded accessible `findByRole` condition. | The two shortcut cases and Resolve case passed 20 repetitions each (60 tests, 400 assertions) under concurrent load. |
| Electron command shims and aggregate 5-second timeout clusters | Subprocess-backed `git`, `gh`, Docker, launcher, runtime-shell, gateway, title-generation, backend-startup, and repository-scan cases could outlive Bun's generic outer deadline. Cleanup then removed a shim underneath the still-running command, producing misleading follow-on failures. The readiness case additionally gave the post-start shim only a two-second inner observation window. | Retain bounded condition diagnostics and give the affected subprocess-backed cases explicit outer budgets, including PR verification, Linux fallback, three direct-container credential cases, and slow managed-Serve readiness; give the readiness signal a ten-second diagnostic window. | The seven affected Electron owners passed inside the focused 293-test run. The complete `bun run test` then passed all four groups: root/agent-support in 72.7 s and bridges in 52.1 s. |
| Oversized tmux blocking hook | The deny response and removal of the pending approval file are separate filesystem observations. The test synchronously checked deletion immediately after the response appeared. | Poll the pending path's absence with the existing bounded diagnostic before asserting that no truncated approval event was broadcast. | Included in the 577-test root stress run. |
| `scripts/test-all.ts` concurrency assertion | The original five-millisecond and replacement one-second bounds both assumed artifact pruning would finish within an arbitrary threshold. Removing the bound entirely made a sequential regression deadlock on the deliberately held WORKSPACE gate. | Use a 15-second diagnostic bound and a 30-second test budget, capture the groups that started before releasing WORKSPACE, then assert against that captured set after the run settles. | Included in the focused 293-test root/UI run. |
| Virtuoso delayed-handle retry | The assertion slept for 30 ms before readiness, while readiness advances through animation frames; replacing that sleep with arrival polling stopped observing later duplicate retries. | Wait for the first `scrollToIndex` call, then retain a short settling interval before asserting the final call arrays contain exactly one activation. | Included in the focused 293-test root/UI run. |
| Create Environment default mode | The owning module captured “defaults” with each Zustand store's mutable `getState()` at module evaluation. In a combined Bun process, another loaded test could mutate that singleton before this file captured it, turning a contaminated terminal mode into the baseline restored by `beforeEach`. | Capture immutable store creation baselines through `getInitialState()` for config and all model stores. | The exact historical mixed-file command passed 179/179 with 683 assertions; it also passed inside the 577-test root stress run. |

Focused validation and the passing complete concurrent suite are recorded in
the rows above. NativeAgent and FeaturesView remain open because stress passes
alone do not supply the root cause and fix required for resolution.
