# Qualification-tooling review repair: default and browser runs under host load

- **ID:** 9959
- **Status:** open
- **Date observed:** 2026-11-13
- **Snapshot:** `ed9e17607` on `qualification-tooling-1ab05fd26c00-r1` (base
  `17d28238c098b4443d1289df5c4ed75e7cc2802e`), the review repair for to-do
  0031's qualification tooling. The branch changes the live coordinator
  suite's `graph-profiles` scenario, the loopback Anthropic model, two opt-in
  agent-testing specs, `NativeMessage.tsx` (system rows with compaction or
  retry parts) and docs. It changes nothing under `apps/backend`.
- **Host:** Linux x86_64, 16 cores, shared with other worktrees' headless
  Chromium suites. Load averages were 117 to 128 during the first default
  run, about 100 during the browser run and 46 to 77 during the second
  default run.

## Runs

### Default suite, first rerun

`mise run test:logged -- --name review-default-tests-rerun -- mise run test`:
exit 1, killed by `test:logged`'s 1,800,000 ms deadline (`timeoutReason:
absolute`) while the runner was rerunning failing files alone. The groups
took 1,754.8 s (the recorded run on the same commit range took 642.9 s in
total). Root, bridges and Codex protocol groups passed; the workspace group
failed:

| Test | Failure | Owner rerun alone |
| --- | --- | --- |
| `remote gateway > releases a proxy buffer reservation when the downstream disconnects while buffering`, `remote gateway > cancels the upstream request when the preview client disconnects` (`apps/backend/tests/gateway-proxy.test.ts`) | 5 s timeouts | Passed (the runner's own rerun, 23.7 s; and `bun --cwd=apps/backend test --preload ../../tests/setup-node.ts ./tests/gateway-proxy.test.ts` through `test:logged`, 22.7 s). |
| `agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes` (`apps/backend/tests/agent-mail-store-size-bench.test.ts`) | 5 s timeout; the test spawns six `bun` children | **Failed alone too** (5,001.79 ms, empty stderr from the killed child) at load about 117, so it is not counted as a flake here. It passed in the second default run below. |
| `raw StorageDatabase writers outside StorageService > name the store they write` (`apps/backend/src/core/storage-writer-guards-raw.test.ts`) | 7,648 ms timeout | Passed alone (2.8 s). Recurrence of [1309](../backend-services-and-tooling/1309-storage-writer-guard-raw-scan-timeout.md). |
| `first sends in two tab groups > each keeps its own prompt until its own turn is observed` (`apps/web/src/components/projects/CoordinatorPanel.concurrency.test.tsx`) | `waitFor` timeout | Passed alone. |
| `a command window with a leaf selected only offers scheduling on the window machine` (`apps/web/src/components/settings/SettingsPage.machine-routing.test.tsx`) | 5 s timeout | Passed alone. |
| ``a `latest` view hidden inside an active host > returning to other content in the same list shows its newest message`` (`apps/web/src/hooks/useVirtuosoScrollState.return.test.ts`) | `followOutput(true)` was `false`, not `"auto"` | Passed alone. |

The three web owners were rerun together alone with
`NODE_ENV=test mise run test:logged -- --name web-reruns -- bun --cwd=apps/web test <the three files> --parallel=1`:
exit 0.

### Default suite, second rerun

`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`:
exit 1 after the groups finished in 1,195.1 s. Root, bridges and Codex
protocol groups passed. One workspace failure:
`agent-tools peer gate > undecided peers get no parser or Expect replies while admission is pending`
(`apps/backend/src/core/agent-tools-peer-gate.test.ts`), a 5 s timeout
(5,026 ms). The runner's own rerun of the owning file alone passed
(500.7 s, of which about 500 s was queued behind another worktree's
exclusive resource).

### Component browser suite

`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 mise run test:logged -- --name browser-rerun -- mise run test:browser`
(the recorded command was incomplete after 1,800 s with no output) reached
592 of 1,884 tests in about 30 minutes with 171 failure lines, nearly all
`page.goto`, `page.reload` or test timeouts at 30 s across about 30 specs.
It was stopped there, since it would not finish before its deadline.

The failing specs that render chat or transcript rows (the area this branch
changes) were then run together with
`NODE_ENV= mise run test:logged -- --name browser-chat-specs -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ChatColumnShift.spec.ts e2e/NativeComposeBar.spec.ts e2e/InspectorTranscriptHide.spec.ts e2e/BackgroundTaskOutcome.spec.ts e2e/NativeResumeSession.spec.ts e2e/NativeChatShellDockNotice.spec.ts e2e/ClaudeInteractions.spec.ts --workers=2`:
89 passed, 1 skipped, 2 failed (11.3 min). Each was rerun alone with
`--project=desktop-chromium --workers=1`:

- `a paused Claude question stays paused across a reload, then resumes and answers`
  (`e2e/ClaudeInteractions.spec.ts:100`), `Request context disposed`: passed
  alone. Recurrence of
  [0252](../native-agents-and-transcripts/0252-claude-paused-question-route-disposal.md).
- `Build Pipeline with a review report keeps a reader's place across another node`
  (`e2e/InspectorTranscriptHide.spec.ts:183`), settled offset 11,855 against
  the reader's 11,655 at line 223: **failed alone too**. Recorded against
  [9981](../web-ui/9981-inspector-reader-place-webkit-restore.md). The
  fixture's transcript is 40 assistant text rows, so the branch's
  `NativeMessage.tsx` change (system rows with compaction or retry parts)
  does not render in it.

## Hypothesis

Shared-host CPU saturation, consistent with every failure being a fixed
deadline or a frame-timing assertion and with every owner but two passing
alone. Not confirmed. No assertion, timeout, retry or skip was changed.

## Not established

`mise run test:browser` did not complete on this snapshot, and the
public-site config did not run. No default-suite run on this snapshot was
green from start to finish.

## Recurrence and repair: `useVirtuosoScrollState.return` (2026-11-13)

The same assertion failed again in Multi Review preparation's `test:full` for
branch `test-core-count-2ea1f7178998-r1` at `5da57d190` (base `263eea27d`),
then passed alone. It is a test race, not host load alone: the navigation to
the end writes `scrollTop = 4400` a frame before its operation settles, and
`followAllowed` requires no operation in flight. The test checked
`followOutput(true)` on the first `waitFor` poll that saw the position. That
branch's 10 ms `waitFor` interval (from 50 ms) made the in-between frame easier
to hit. Under eight-way parallel runs the unchanged test failed 1 of 48. The five tests
with this pattern now wait for the position and the rendered `followEnabled`
together (`waitForFollowingAtEnd`), then assert `followOutput(true)` once as
before; the whole file passed 80 of 80 under the same load. Other owners in
this case are unaffected.
