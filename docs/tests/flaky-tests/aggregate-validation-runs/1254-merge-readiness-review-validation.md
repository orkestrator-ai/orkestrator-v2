# Merge-readiness review validation

- **ID:** 1254
- **Status:** open
- **Date observed:** 2026-10-28
- **Implementation commit:** `92f8a1f92`

The review fixes require confirmation after PR monitoring resumes, veto a
conflicting or unknown monitor reading, clear predecessor mergeability when
setting another PR, and suppress remote readiness until leaf monitor health
is relayed. Regression coverage includes the runtime persistence effect,
persisted/reloaded mergeability, in-memory PR replacement, remote search,
remote sidebar and remote mobile titles.

## Focused validation

All changed-file Bun owners passed through `test:logged`: the readiness
adapter, project search, environment store, AppShell, federation UI, PR monitor
service/lifecycle/runtime and agent-completion integration owners. The slow
integration owner also passed separately (2.3 s). Both package typechecks and
format/lint checks of edited source files passed. The focused
`e2e/MergeReadyShimmer.spec.ts` browser owner passed both viewports (9.0 s),
including normal motion, reduced motion and forced colors.

The preparation command from the repository root matched no integration
tests again because the root test config excludes backend sources. The
corrected invocation passed:

```sh
mise run test:logged -- --name pr-monitor-agent-completion -- bun test --cwd apps/backend ./src/core/pr-monitor-agent-completion.integration.test.ts --parallel=1 --only-failures
```

`docs/development/testing-guide.md` now records the package-cwd requirement
and the distinction between `bun test --cwd …` and `bun --cwd … test`.

## Default suite reruns

The final exact `mise run test` rerun ran through:

```sh
mise run test:logged -- --name review-default-final -- mise run test
```

The command exited 1 after 639.9 s with seven failures outside the edited
paths. The renderer suite passed all 10,356 tests; the backend reported 10,161
passes and four failures, bridges two failures, and root tests one failure.
Complete owner reruns:

| Owner | Aggregate failure | Separate owner result |
| --- | --- | --- |
| `bridges/codex-bridge/src/runtime-env.test.ts` | Runtime helper refresh timed out at 15,149.59 ms | Passed, 0.6 s; tracked in 0093 |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | Failed-settling-read case timed out at 2,063.97 ms | Passed, 1.6 s; a preceding two-owner run reproduced the documented pre-plugin stale/ready race (0791) |
| `apps/backend/src/core/native-agent-service-reconciliation.test.ts` | Shared observations fixture received zero HTTP requests | Passed, 15.3 s; tracked in 0672 |
| `apps/backend/src/core/public-api/test-support.test.ts` | Restart case exceeded 5 s | Passed, 6.2 s; tracked in 1240/1245 |
| `apps/backend/tests/standalone-ready.test.ts` | Observed SIGKILL before the first grace-period assertion (136.57 ms) | Passed, 0.9 s; tracked in 0491 |
| `apps/backend/src/core/feature-planning.test.ts` | Dispatch-time timeout case saw `failed` instead of `running` (222.85 ms) | Passed, 9.6 s |
| `tests/unit/disk-report.test.ts` | Isolated checkout report/fix case exceeded 5 s | Passed, 6.4 s |

Owner commands use `bun test --cwd <package> ./<owner> --parallel=1
--only-failures` through `test:logged`; disk-report uses its root-relative
`./tests/unit/disk-report.test.ts` path. No implementation, assertions,
timeouts or skips in these owners changed. The cause of the intermittent
failures is not established.

Evidence is under the host temporary directory:
`orkestrator-test-run.iYpePC/` (aggregate group logs) and
`orkestrator-test-run.y3yArt/` (logging wrapper).
The earlier rerun repeated Claude runtime preference retention (1221), whose
unchanged owner passed separately in 2.2 s. Preparation's fsmonitor deadlines
(1253) passed their unchanged owner separately in 12.6 s. Those recurrences
are also recorded in their existing cases.

## Browser and Docker limitations

The default fixture port belonged to another checkout. Its process was left
alone; the browser command was rerun on free fixture ports 24622 and 24623:

```sh
ORKESTRATOR_E2E_PORT=24622 ORKESTRATOR_PUBLIC_E2E_PORT=24623 mise run test:logged -- --name review-browser-final -- mise run test:browser
```

The browser rerun exited 1 after 1,151.0 s: 901 passed, 105 skipped and
10 failed. All four readiness cases passed (mobile and desktop). The failures
were in unchanged owners:

- `AgentLaunchDialog.spec.ts`: native branch suggestion selection, both viewports.
- `ClaudeInteractions.spec.ts`: paused question across reload, mobile.
- `DataSavingGateway.spec.ts`: client-local persistence and event latency, mobile.
- `DesignCanvas.spec.ts`: edit/isolation/reload scenario, both viewports.
- `NativeHeldSend.spec.ts`: device-code recovery, mobile.
- `PaneBreakpoint.spec.ts`: pane-tree moveBefore, appendChild fallback and
  app-shell moveBefore cases, mobile.

These browser failures were not investigated or classified as flakes in this
readiness fix. Their evidence is
`orkestrator-test-run.zvV1LS/review-browser-final.log.gz` in the host temporary
directory and the Playwright artifacts under `output/playwright/test-results/`.
The public-site stage was not reached because the component-browser stage
failed. The e2e typecheck passed before browser execution.

The exact Docker preparation command was also rerun:

```sh
mise run test:logged -- --name agent-docker -- mise run test:agent:docker
```

It retained 14 failures and 4 skips: image
`orkestrator-v2:dev-b6a190ea8d22` was unavailable and the `codex-qa` profile was
offline. Evidence: `orkestrator-test-run.FtIXF6/agent-docker.log.gz` in the host
temporary directory. No Docker lifecycle implementation changed in this fix.


## Leaf checks and credential rotation review — 2026-10-30

The next review round relays bounded leaf check counts and rollup-only health
hints, initializes monitoring from health-enriched summary traffic, invalidates
permission scopes around Settings and container credential writes, and treats an
empty permissions object as unknown. Old in-flight permission answers are
superseded. No browser owner, assertion, timeout or skip changed.

Changed-area validation passed through `test:logged`:

- Backend readiness, runtime, credential rotation, container boundary and node
  read-model owners (`pr-health-backend`, four workers, 2.7 s).
- Cold-start/restart integration with real summary handlers, runtime and node
  relay (`pr-health-cold-start`, one worker, final health-hint-only run 2.0 s).
- Existing environment creation/lifecycle, project, Docker, PR merge and review
  command owners (`pr-health-command-owners`, two workers, 52.8 s).
- Renderer readiness and protocol summary/readiness owners.
- Scoped backend, web and protocol typechecks; edited-file oxlint; repository
  `mise run format:check`; `git diff --check`.

Preparation recorded `mise run test` as incomplete while waiting for host
capacity and the exact browser command as failed (971 passed, 106 skipped,
seven failures across 1,084 cases). Both commands were rerun for this round.
The default fixture port was owned by another checkout, so browser reruns use
`ORKESTRATOR_E2E_PORT=1437`; that other server was left alone.

A six-owner diagnostic run on that port used the complete unchanged
AgentLaunchDialog, DataSavingGateway, KeyboardShortcuts, PipelineFlow,
StreamingTranscript and ToolGroupFold files with nine workers. It reported
178 passed and eight failures in 126.2 s. Native branch selection failed in both
viewports (`rel` rather than `release/2.0`); mobile data saving exceeded its
60-second deadline; four mobile group animation/overscan cases failed, and
desktop waiting-group scrolling stayed at 704 rather than zero. The evidence
is `orkestrator-test-run.XREdRM/browser-preparation-failures.log.gz` under the
host temporary directory. This diagnostic is separate from the exact aggregate
rerun.

Complete owner reruns use a separate fixture port and output directory:

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-<Owner>-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/<Owner>.spec.ts --workers=1 --output output/playwright/pr-review-<Owner>-owner
```

- AgentLaunchDialog: two passed, two failed in 33.8 s. The same native picker
  assertion failed in both viewports; this is a persistent unrelated limitation,
  already recorded above. Evidence: `orkestrator-test-run.2nvlQK/`.
- DataSavingGateway: both cases passed unchanged in 51.9 s, confirming another
  intermittent observation of [1310](../previews-annotations-and-gateway/1310-data-saving-gateway-browser-timeout.md).
- KeyboardShortcuts: the complete unchanged owner passed in 174.7 s. This
  confirms intermittence of preparation's mobile assigned-agent Meta+I
  composer lookup failure; no shortcut code changed.
- PipelineFlow: the complete unchanged owner passed in 131.3 s, confirming a
  recurrence of [1121](../coordinator-and-multi-review/1121-pipeline-flow-rehydrate-load-timeout.md).

- StreamingTranscript: the complete unchanged owner passed in 72.9 s, including
  find convergence in both viewports ([0767](../native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md)).
- ToolGroupFold: the complete unchanged owner passed in 98.0 s, including
  preparation's fold-gap failure ([1012](../web-ui/1012-live-tool-fold-threshold-gap.md))
  and the diagnostic's animation/overscan and waiting-group failures (0747/0793).

These owner commands each contain only the named file and run serially with
one worker. The exact aggregate browser rerun and other checkouts' validation
were still active on the host; the observations do not establish contention
as the root cause.

The exact browser rerun completed (exit 1, 632.6 s):

```sh
ORKESTRATOR_E2E_PORT=1437 mise run test:logged -- --name browser -- mise run test:browser
```

It reported **976 passed, 106 skipped and two failed**, both unchanged native
branch-selection cases in AgentLaunchDialog. Every readiness, sidebar,
keyboard, pipeline, streaming and tool-group case passed. Evidence is
`orkestrator-test-run.VyCqpD/browser.log.gz` under the host temporary directory;
Playwright artifacts are under `output/playwright/test-results/`. The chained
public-site stage was blocked by the component failure.

The public-site stage passed separately (10.6 s):

```sh
ORKESTRATOR_PUBLIC_E2E_PORT=4457 mise run test:logged -- --name pr-review-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```

Implementation fixes are committed as `deb4c1821`.

The exact `mise run test` rerun obtained host capacity after 744.2 s of waiting.
Its root, bridge and protocol-lockfile groups passed.

The first exact default-suite rerun completed in 912.6 s including that queue
wait. Only two tests failed: scheduler Settings-switch fixtures in
`apps/backend/src/core/scheduled-jobs/service.test.ts` supplied a partial
runtime without the permission cache that Settings writes now use. This was
a fixture integration defect, not a flake. The fixture now supplies a real
`PrViewerPermissionCache` (`150886d88`). Its complete owner passed in 1.0 s;
backend typecheck and file lint/format passed. All renderer tests passed
(10,845 passed, ten skipped), as did the other workspace packages.

The initial default failure evidence is
`orkestrator-test-run.0buP3F/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. After the fixture repair, the exact
`mise run test` command was run again.

The final exact default-suite rerun exited 1 in 449.7 s including an 83.7 s
capacity wait. Backend reported **11,323 passed, 87 skipped and one failed**;
renderer reported **10,845 passed, ten skipped and zero failed**. All other
workspace packages, root, bridges and the protocol lockfile passed. The
scheduler fixture cases and every PR-readiness regression passed.

The remaining failure was the unchanged design browser-profile cleanup case
[1314](../design-canvas-and-artifacts/1314-design-profile-ledger-cleanup-race.md):
a profile had disappeared but its ledger JSON still existed (300.67 ms). The
complete unchanged owner passed alone with one worker in 0.9 s:

```sh
mise run test:logged -- --name pr-review-browser-profiles-owner -- bun test --cwd apps/backend ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Evidence is
`orkestrator-test-run.mtfML9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. No design cleanup implementation,
assertion, timeout or skip changed. The full default and browser commands
remain non-green because of these recorded unrelated failures.
