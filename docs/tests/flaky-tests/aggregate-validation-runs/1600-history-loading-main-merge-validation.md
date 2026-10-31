# Automatic history loading main-merge validation

- **ID:** 1600
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** transcript paging, tool-group folding, transcript follow, and unrelated repository/browser validation failures
- **File:** `e2e/TranscriptPaging.spec.ts`; `e2e/ToolGroupFold.spec.ts`; `e2e/VirtuosoFollow.spec.ts`; `e2e/MultiReviewFlow.spec.ts`; `e2e/MultiReviewPackageLayout.spec.ts`; `apps/web/src/components/settings/SettingsPageLayout.test.tsx`
- **Revision:** merge of feature parent `ec2018fe6145068ac87ddf8860e1b19c90c64e3e` and main parent `f489d57755deedb12c843579e10f9a1d60761dd4`.

## Commands and outcomes

All commands ran from the repository root with the pinned Bun runtime.
The host inherits `NODE_ENV=production`; tests below explicitly use `NODE_ENV=test`.
The first focused attempt inherited production and failed because React's test
`act` helper was unavailable. The corrected command passed all 69 tests:

```sh
NODE_ENV=test mise run test:logged -- --name merge-native-focused -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.progressive.test.tsx ./src/components/native-agent/AgentNativeTab.goal.test.tsx ./src/components/native-agent/useAutoLoadEarlier.test.tsx --parallel=2 --only-failures
```

`mise run test:logged -- --name merge-check -- mise run check` passed formatting
and lint (existing unused-import warnings), then failed desktop typechecking
because `@babel/core` was not installed. `NODE_ENV=development mise exec -- bun
install --frozen-lockfile` installed missing dependencies without changing the
lockfile. `NODE_ENV=test mise run test:logged -- --name merge-typecheck -- mise
run typecheck` then passed all package, root and e2e typechecks.

```sh
NODE_ENV=test mise run test:logged -- --name merge-tests -- mise run test
```

The default suite exited 1 in 299.4 s. Root/agent-support, bridges and the Codex
protocol lockfile groups passed; the workspace group retained two failures in
`SettingsPageLayout.test.tsx`: `follows the environment preview services component`
and `no settings page centers or sizes itself instead of using SettingsPageLayout`.
Both raise ENOENT for `apps/web/src/components/docker/DockerStatsDialog.tsx`.
The complete unchanged owner reproduced both failures (seven passed, two failed):

```sh
NODE_ENV=test mise run test:logged -- --name merge-settings-owner -- bun test --cwd apps/web ./src/components/settings/SettingsPageLayout.test.tsx --parallel=1 --only-failures
```

The test is byte-identical to `origin/main` at the recorded main parent, and
that tree also lacks the referenced file. This is a deterministic target-branch
failure, not a newly confirmed flake.

```sh
NODE_ENV=test ORKESTRATOR_E2E_PORT=21758 ORKESTRATOR_PUBLIC_E2E_PORT=24238 mise run test:logged -- --name merge-browser -- mise run test:browser
```

The eight-worker component suite exited 1 in 740.9 s: 1,011 passed, 108 skipped,
15 failed. Four failures in `AgentLaunchDialog.spec.ts` were missing Chrome at
`/opt/google/chrome/chrome`, not flaky assertions. The remaining failures were:

- `MultiReviewFlow.spec.ts:107`: mobile `puts a running node's elapsed time and tokens on its own third row`; expected the queued model label to overflow, received false.
- `MultiReviewPackageLayout.spec.ts:4`: `package validation and transcript fit a 1408px container`, both viewports; footer-to-log gap was -25 px instead of at least zero.
- `ToolGroupFold.spec.ts:79`: `a live group crossing the fold threshold folds into its line with no-preference motion`, both viewports; gaps were 9 px (mobile) and 15 px (desktop), expected at most 2 px. Existing case [1012](../web-ui/1012-live-tool-fold-threshold-gap.md).
- `ToolGroupFold.spec.ts:153`: `a live group growing below a released reader preserves their place with no-preference motion`, both viewports; mobile timed out after 30 s awaiting `scrollend`, desktop bottom gap stayed 19 px instead of greater than 100 px.
- `TranscriptPaging.spec.ts:22`: `native: paging before prose holds the original tool position`, both viewports, plus the desktop byte-bounded variant; row index stayed 1 instead of greater than 1. Existing case [0483](../native-agents-and-transcripts/0483-transcript-paging-prepend-index-timing.md).
- `VirtuosoFollow.spec.ts:57`: desktop `a small wheel release stays unfollowed through growth inside the bottom band`; follow decision stayed false instead of auto. Existing case [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md).

The five complete unchanged owning files then ran sequentially with one worker:

```sh
NODE_ENV=test ORKESTRATOR_E2E_PORT=21758 mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts e2e/ToolGroupFold.spec.ts e2e/MultiReviewFlow.spec.ts e2e/MultiReviewPackageLayout.spec.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output=/tmp/orkestrator-merge-d0e2e68a-browser-owners
```

Result: exit 1 in 422.8 s, 189 passed, six skipped, three failed. Complete paging,
folding and follow owners passed across both viewports, confirming those
aggregate failures were intermittent; no root cause was established. The mobile
multi-review label-width assertion and both 1408px package-layout assertions
failed again. These three are retained failures, not newly classified flakes.
No implementation, assertion, deadline or skip was changed to make tests pass.

The component failures prevented the chained public-site suite, so it ran
separately and passed (14.1 s):

```sh
NODE_ENV=test ORKESTRATOR_PUBLIC_E2E_PORT=24238 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1 --output=/tmp/orkestrator-merge-d0e2e68a-public-browser
```

## Evidence and remaining limits

Failure logs and summaries are under the host temporary directory:

- `orkestrator-test-run.QQU690/merge-tests.log.gz` (nested aggregate artifacts: `orkestrator-test-run.qF7oA4`).
- `orkestrator-test-run.aA3mY2/merge-settings-owner.log.gz`.
- `orkestrator-test-run.rJPrwg/merge-browser.log.gz`.
- `orkestrator-test-run.zM5BRG/merge-browser-owners.log.gz`.

The corrected focused pass summary is `orkestrator-test-run.roaFSl/summary.json`.
Passing raw output is removed by the logged runner. Broad repository/browser
validation remains non-green despite the passing native-agent checks and
complete paging/fold/follow owners. Live-agent, Electron and Docker suites
were outside this merge-conflict scope; no isolated live profile was started.
