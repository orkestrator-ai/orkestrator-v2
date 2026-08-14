# Flaky tests

This living record tracks tests that fail during normal aggregate or parallel execution
but pass when their owning file is rerun alone. A single failure is not treated
as a flake until that isolated rerun passes. Resolved entries remain here with
their root cause, fix, and verification history.

This file is the only flake registry. An earlier `docs/flake-tests.md` recorded
the same incidents in a second format; its entries were merged here on
2026-08-07 and that file was removed, so a recurrence is compared against one
history rather than two partial ones.

## `Electron tmux backend command registration` aggregate launch/cleanup failures (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group ran `bun test ./tests ./e2e/agent-testing/artifact-sanitizer.test.ts ./test-fixtures/agent-project/server.test.ts --parallel=4` while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** Five cases failed in one stateful owning file: `writes an owner-only agent MCP config and includes it in a local Claude launch` timed out after 5,000 ms (5,002.60 ms); `does not create an agent MCP config when Claude lacks the launch flag` then requested a connection the fixture declares unreachable (344.24 ms); `serializes stop behind an in-flight start so no tmux session is orphaned` timed out waiting for its condition (2,006.39 ms); `keeps per-environment hook state under the shared runtime root and removes it on stop` reached a missing fake Claude executable (621.98 ms); and `environment teardown kills live sessions, restores settings and removes the runtime root` found no fake tmux log (1,675.57 ms).
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors. The other two root failures are recorded separately below.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts 2>&1 | tee /tmp/orkestrator-tmux-backend-isolated-acp-image-fixes.log` -> 173 passed, 0 failed, 615 assertions in 74.19 seconds; all five affected cases passed.
- **Hypothesis:** The first failure is a bare five-second timeout in a process-heavy fixture while four aggregate groups compete for process startup. Because the file shares fake runtime/module state across its lifecycle tests, interruption of that first case's cleanup plausibly caused the four later missing-runtime and ordering failures; the complete file rebuilt and cleaned every fixture successfully in a fresh isolated process. No product code touched by the ACP image change appears in these stacks.

## `download-claude.sh > downloads, extracts, probes, and cleans up on Darwin/x86_64` (`tests/unit/download-scripts.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 15000ms` (duration: 15,772.04 ms).
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/download-scripts.test.ts 2>&1 | tee /tmp/orkestrator-download-scripts-isolated-acp-image-fixes.log` -> 33 passed, 0 failed, 158 assertions in 27.11 seconds; the affected case passed in 3,951.34 ms.
- **Hypothesis:** The case launches a shell download/extract/probe harness and exceeded only its outer wall-clock budget during a run with several other process-heavy groups. Its functional assertions completed more than eleven seconds inside that budget in isolation; no download or toolchain code changed in this work.

## `NativeMessage > derives image mime types from the container attachment extension` (`tests/unit/components/NativeMessage.test.tsx`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The asynchronous two-preview case failed after 13,950.37 ms. Bun's retained failure payload expanded the React fiber/DOM object rather than preserving a concise matcher message.
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/components/NativeMessage.test.tsx 2>&1 | tee /tmp/orkestrator-native-message-isolated-acp-image-fixes.log` -> 93 passed, 0 failed, 296 assertions in 1.81 seconds; the affected case passed in 43.01 ms.
- **Hypothesis:** The case opens one asynchronous image preview, closes it through React, then opens a second. The same transitions completed immediately in a clean process, while the aggregate run was already experiencing severe process and renderer scheduling contention. The reviewed ACP fix changes bridge URL creation only; this root-level renderer test uses fixed `/workspace/...` paths and did not execute that code.

## `Codex session titles > rejects spawn, nonzero, signal, and invalid-output failures and cleans temporary state` (`bridges/codex-bridge/src/session-titles.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel=2` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 5000ms` (duration: 6,205.38 ms).
- **Suite counts:** Bridge group: 2,394 total, 2,382 passed, 11 skipped, and 1 failed.
- **Isolated rerun:** `set -o pipefail; bun test ./bridges/codex-bridge/src/session-titles.test.ts 2>&1 | tee /tmp/orkestrator-session-titles-isolated-acp-image-fixes.log` -> 17 passed, 0 failed, 90 assertions in 6.70 seconds; the affected case passed in 1,918.92 ms.
- **Hypothesis:** The case intentionally exercises several child-process failure modes under one five-second outer budget. It exceeded that budget only while the bridge and root process-heavy suites overlapped and completed well inside it when isolated; neither session-title code nor its tests changed in this work.

## `Electron tmux backend command registration` timeout cluster (`tests/unit/electron/tmux-backend.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran concurrently with the workspace, bridges, and codex protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** six cases in this one file exhausted their outer budget with no assertion failure. `starts separate tmux sessions for generated tab ids with the same old prefix` (5,005.47 ms), `attaches duplicate client starts to one tmux session unless replacement is explicit` (5,001.94 ms), `generated blocking hooks use an integer timeout and fail closed on expiry` (5,006.09 ms), `reports prompt, exit, capture, send, and transition failures` (5,002.09 ms) each hit the 5,000 ms limit; `serializes stop behind an in-flight start so no tmux session is orphaned` (2,004.37 ms) and `serializes interactive input and interrupts behind a mode transition` (724.26 ms) hit their own shorter internal waits.
- **Suite counts:** root and agent-support group: 1 skipped and 7 failed (these six plus the separate `deduplicates concurrent background starts for one environment` entry below). The workspace, bridges, and codex protocol-lockfile groups passed.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/tmux-backend.test.ts --parallel 2>&1 | tee /tmp/fix-tmux-isolated.log` -> 173 passed, 0 failed, 615 assertions in 64.43 seconds.
- **Group rerun:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/fix-root-group.log` -> 3,641 passed, 1 skipped, 0 failed, 16,435 assertions across 143 files in 136.42 seconds. The cluster does not reproduce when the root group runs without the other groups competing for workers.
- **Hypothesis:** these cases drive a real `tmux` server and poll its state on wall-clock deadlines, so they are the group's most timing-sensitive file. They fail together, only in the four-group aggregate, and pass both alone and as a whole-group run, which points at CPU contention pushing the polls past fixed real-time budgets rather than at a product race. Replacing the fixed deadlines with an injected clock or an explicit readiness signal should be evaluated before changing the tmux runtime.

## `Electron backend command registry > deduplicates concurrent background starts for one environment` (`tests/unit/electron/commands.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/rev-full-tests.log`, and again in `/tmp/fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran concurrently with the workspace, bridges, and codex protocol-lockfile groups.
- **Failure:** `error: Timed out waiting for deduplicated background start to finish` raised by the file's own `waitForCondition` helper (`tests/unit/electron/commands.test.ts:1115`) after its 3,000 ms poll expired (durations 3,009.85 ms and 3,008.20 ms across the two aggregate runs). No assertion mismatch was reported.
- **Suite counts:** first aggregate: root and agent-support group 3,641 passed, 1 skipped, 1 failed, 16,428 assertions across 145 files in 290.05 seconds; all other groups passed. Second aggregate: same test failed alongside the tmux cluster above.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts --parallel 2>&1 | tee /tmp/rev-commands-isolated.log` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 77.51 seconds.
- **Group rerun:** `bun test ./tests --parallel` -> 0 failed (see the cluster entry above).
- **Hypothesis:** the helper polls for the deduplicated start to settle on a fixed 3,000 ms wall-clock budget while the case also stands up a fake Docker and a fake `gh`. Under aggregate contention the supervised work completes later than that budget allows. The deduplication behaviour itself is what the case asserts, and it holds in both isolated and whole-group runs, so the budget rather than the product logic is the first thing to re-examine.

## `MobileAppShellLayout > opens the project drawer on initial mobile entry and keeps workspace content mounted` (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c4cb555c-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The test exceeded Bun's 5,000 ms outer budget and timed out after 5,014.67 ms. No assertion failure was reported.
- **Suite counts:** Web package: 4,805 total, 4,803 passed, 1 skipped, 1 failed across 210 files with 14,866 assertions in 104.69 seconds. The backend, root, bridge, protocol, CLI, desktop, and web-public groups passed.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-fix-mobile-layout-isolated.log` -> 23 passed, 0 failed in 4.41 seconds; the affected case passed in 2,197.66 ms.
- **Root cause:** The case combined the initial Radix drawer auto-focus boundary and a later close-and-restore focus boundary under one five-second test budget. The two behaviors are independent and each already has a distinct user-visible assertion, but their asynchronous focus work accumulated enough aggregate scheduling delay to exhaust the shared budget.
- **Fix:** Split the initial-open and close-button focus behaviors into separate tests so each transition has an independent lifecycle and budget without weakening either assertion.
- **Verification:** The owning file is stress-tested after the split and the subsequent aggregate result is recorded in this change's validation handoff.

## `MultiReviewService keeps a provider alive while a transcript read overlaps fix execution` (`apps/backend/src/core/multi-review-service.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests4.log`
- **Worker configuration:** the backend workspace package ran `bun test src tests --parallel` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** `expect(received).toBe(expected)` at `multi-review-service.test.ts:278` — expected `2` disposals, received `1` (duration: 132.84 ms). Line 278 is the second disposal assertion, made after the blocked status call is released and the run reaches `completed`.
- **Suite counts:** the aggregate's only failure; every other group passed. Observed in three of five consecutive full runs on 2026-08-14 and absent from the other two.
- **Isolated rerun:** `bun test --cwd apps/backend src/core/multi-review-service.test.ts` -> 31 passed, 1 failed on the first attempt, then five consecutive repetitions of the same command failed once and passed four times (32 passed, 0 failed).
- **Not caused by the change under review:** reproduced on a clean tree with the working change stashed (`git stash push --include-untracked`), which failed the same assertion at 128.45 ms.
- **Hypothesis:** the test waits for `phase === "completed"` and then asserts the disposal count, but reaching `completed` and disposing the provider are separate steps. When the scheduler runs the snapshot poll between them the count is still at its previous value. The assertion likely needs to wait on the disposal itself rather than on the phase that precedes it.

## `StorageService prompt queues > live lease timer restores and announces a sole claimed head` (`apps/backend/src/core/storage-prompt-queues.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-980919fe-full-tests.log`
- **Worker configuration:** The backend workspace package ran `bun test src tests --parallel` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The queue had recovered the expired sole claim and reached revision 3, but `events` was still `[]` instead of containing the expected `{ resource: "prompt-queue", id: "e1" }` announcement (duration: 44.42 ms).
- **Suite counts:** Backend package: 1,647 total, 1,646 passed, 1 failed across 55 files. The aggregate also had one separate deterministic root-suite failure from the reviewed activity-source change.
- **Isolated rerun:** `bun test --cwd apps/backend src/core/storage-prompt-queues.test.ts` -> 57 passed, 0 failed, 197 assertions in 1.87 seconds; the target passed in 51.94 ms.
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

- **Status:** open
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

- **Status:** open
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

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `bun run test` (workspace group, Turbo task `@orkestrator/cli#test:workspace`).
- **Worker configuration:** Turbo's workspace group running concurrently with the root, bridge, and protocol-lockfile groups. Unlike the resolved built-artifact flake above, the CLI file was selected exactly once — the duplicate-selection root cause fixed there does not apply here.
- **Failure:** Two cases in the same run.
  1. `starts and gracefully stops the packaged backend` (4,327.86 ms): `expect(received).toBe(expected)`, `Expected: 0`, `Received: 143`, at `cli.test.ts:267:55`, followed by `killed 1 dangling process`. 143 is SIGTERM, so the packaged backend did not complete its graceful shutdown inside the window the test allows before the harness force-kills it.
  2. `starts when the caller's environment already sets NODE_ENV` (5,001.07 ms): `this test timed out after 5000ms`, plus an unhandled `error: Packaged backend did not become ready:` (empty stderr payload) from `startPackagedBackend` at `cli.test.ts:145:15`, called from `cli.test.ts:274:45`.
- **Suite counts:** CLI package 6 passed, 2 failed, 1 error; Turbo reported `Tasks: 5 successful, 7 total` with `Failed: orkestrator#test:workspace`. Concurrent groups were green: root 3,903 passed / 1 skipped / 0 failed; bridges 2,372 passed / 11 skipped / 0 failed; codex protocol lockfile passed. Turbo aborted the workspace group on this failure, so the web, desktop, and web-public workspace tasks did not execute in that run and iOS never started.
- **Isolated rerun:** `bun run --cwd packages/cli test` (builds, then `bun test tests --parallel`) -> 8 passed, 0 failed, 27 assertions in 2.17 seconds. Both affected cases passed.
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

## `standalone backend service > can own a Tailscale Serve listener and publish its HTTPS URL` (`apps/backend/tests/standalone.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout (reported duration 5,000.60 ms); Bun also reported an unhandled `Backend exited during startup:` error with empty stderr from `startBackend` and killed three dangling processes
- **Suite counts:** Backend package: 1,519 tests, 1,518 passed, 1 failed, plus 1 between-test error
- **Isolated rerun:** `bun test ./tests/standalone.test.ts` from `apps/backend` -> 8 passed, 0 failed; the target passed in 2,159.94 ms
- **Recurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log` ran the backend workspace as `bun test src tests --parallel` alongside the web, root, bridge, and protocol-lockfile groups. The target completed its startup assertions but the final graceful-shutdown assertion expected exit code `0` and received signal-derived exit code `143` (duration: 4,834.76 ms).
- **Recurrence suite counts:** Backend package: 1,684 total, 1,682 passed, 2 failed across 55 files; the other failure was the separate MultiReview flake below. Root/agent-support and the protocol lockfile passed; the bridge group had one separate aggregate-only failure.
- **Recurrence isolated rerun:** `bun test ./tests/standalone.test.ts --parallel` from `apps/backend` -> 8 passed, 0 failed in 10.82 seconds; the target passed in 2,304.52 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-backend-standalone-cwd.log`.
- **Hypothesis:** The new signature is not the previously fixed outer-budget timeout: startup completed and the child received `SIGTERM`, but under aggregate load it exited with the raw signal code before the test observed the expected graceful zero exit. The available run does not establish whether shutdown-handler installation, signal delivery, or process teardown ordering caused that race.
- **Previous root cause:** The original occurrence exhausted the five-second test budget while performing two complete backend lifecycles.
- **Previous fix:** Give the two-lifecycle integration test a 20-second budget while preserving the startup helper's narrower deadline and all functional assertions.
- **Previous verification:** After building the standalone backend, `bun test tests/standalone.test.ts --test-name-pattern 'can own a Tailscale Serve listener' --rerun-each 10` from `apps/backend` -> 10 passed, 0 failed; individual runs completed in 2,037.57-2,896.36 ms.

## `MultiReviewService keeps a provider alive while a transcript read overlaps fix execution` (`apps/backend/src/core/multi-review-service.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The backend workspace ran `bun test src tests --parallel` while the web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** After the overlapping transcript read completed and fix execution reached `completed`, the provider had one disposal instead of the expected two (`Expected: 2`, `Received: 1`) at `multi-review-service.test.ts:278` (duration: 183.68 ms).
- **Suite counts:** Backend package: 1,684 total, 1,682 passed, 2 failed across 55 files. Root/agent-support and the protocol lockfile passed; the bridge group had one separate aggregate-only failure.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts --parallel` from `apps/backend` -> 32 passed, 0 failed in 3.16 seconds; the target passed in 56.74 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-multi-review.log`.
- **Hypothesis:** The workflow reached its durable completed phase before the asynchronous provider-disposal observation became visible under aggregate scheduling. The isolated run proves the production path can satisfy the assertion, but this occurrence does not establish whether the test needs an explicit disposal boundary or the service is publishing completion before cleanup settles.

## `titles > a generated title is persisted for every tab sharing the thread` (`bridges/codex-bridge/src/app-server-runtime.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** The persisted session metadata assertion at `app-server-runtime.test.ts:6651` received additional current metadata fields instead of the expected partial object after the generated shared-thread title was written (duration: 76.07 ms).
- **Suite counts:** Bridge group: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files. Root/agent-support and the protocol lockfile passed; the backend workspace had two separate aggregate-only failures.
- **Isolated rerun:** `bun test ./src/app-server-runtime.test.ts --parallel` from `bridges/codex-bridge` -> 271 passed, 0 failed in 3.54 seconds; the target passed in 29.91 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-app-server-runtime.log`.
- **Hypothesis:** Another aggregate bridge test appears to have populated optional session metadata before this assertion read the shared persisted record. The isolated owner file preserves the expected partial state, but the available diff does not identify the cross-file writer, so no product assertion has been weakened.

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

- **Status:** open
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

- **Status:** open
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

- **Status:** open
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

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/ork-fix-root-tests.log` on an 18-worker macOS host
- **Failure:** the test exceeded Bun's 5,000 ms budget (reported duration 5,002.42 ms) with no assertion message.
- **Suite counts:** root group 3,634 passed, 1 skipped, 4 failed, 3 errors across 143 files in 237.95 s.
- **Isolated rerun:** `bun test ./tests/unit/electron/commands-process-coverage.test.ts --parallel` -> 59 passed, 0 failed in 1.30 s; the whole file costs a fraction of this one test's aggregate budget. Evidence: `/tmp/ork-fix-process-isolated.log`.
- **Recurrence:** the same test also timed out at 5,004.51 ms in the preceding aggregate run at commit `cb520049`, so unlike the `tmux-backend.test.ts` entry above this one has repeated identically across two runs.
- **Hypothesis (not confirmed):** the test asserts that browser/file-manager/editor launches happen without a shell, so it waits on spawned child processes; under a loaded 18-worker run those spawns are contending with every other suite's children. The 1.30 s isolated cost makes an outright hang unlikely. Whether the wait is on process spawn or on a fake-binary lookup has not been established.
- **Clean rerun of the whole group:** a later `bun test ./tests --parallel` on the same host and branch reported 3,638 passed, 1 skipped, 0 failed in 118.36 s — half the wall time of the failing run (237.95 s) and with this test passing, which is consistent with contention rather than a defect in the test.
- **Next step:** instrument which awaited spawn is outstanding at timeout before changing the budget, since a raised budget would hide a genuine spawn regression here.

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

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the remaining workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** Testing Library could not find an accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2474` (duration: 628.67 ms).
- **Suite counts:** Web package: 4,808 total, 4,806 passed, 1 skipped, 1 failed across 210 files.
- **Isolated rerun:** `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel` -> 145 passed, 0 failed, 558 assertions in 15.95 seconds; the target passed in 587.91 ms.
- **Hypothesis:** The aggregate-only result shows the expected long-press dialog was absent when queried, while the full owning file recreates it in isolation. No narrower trigger is established; a recurrence should capture the long-press timer, pointer events, and unmount/remount state before changing the product behavior or assertion.

## `UpdateCoalescer > re-reads a dynamic interval across schedules in both directions` (`bridges/codex-bridge/src/messages/coalescer.test.ts`)

- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` concurrently with the workspace, root, and protocol-lockfile groups.
- **Failure:** Expected `publishedAt` to contain 3 timestamps but received 4 at `coalescer.test.ts:90` (duration: 90.32 ms).
- **Suite counts:** Bridges: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files.
- **Isolated rerun:** `bun test ./bridges/codex-bridge/src/messages/coalescer.test.ts --parallel` -> 9 passed, 0 failed, 23 assertions in 268 ms; the target passed in 78.26 ms.
- **Hypothesis:** The test coordinates multiple real elapsed-time intervals and observed one additional publish only under aggregate scheduling. A deterministic scheduler or callback boundary should be evaluated if it recurs; the available evidence does not establish a production coalescing defect.
