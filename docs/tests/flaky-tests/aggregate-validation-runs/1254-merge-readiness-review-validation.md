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
