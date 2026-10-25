# Scheduled jobs review validation

- **ID:** 0826
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** Scheduled-job catch-up, durable replay, owner checks, retries, timer arming, heartbeat announcements and Settings action preservation, with backend, component, protocol and CLI regression tests.

`mise run test:logged -- --name non-ios-suite -- mise run test` completed
with exit 1. The workspace group took 799.7 s, root 506.7 s, bridges 469.4 s
and the protocol lockfile 5.7 s. The default scheduler admitted workspace,
root, bridges and lockfile groups with 4/1/2/1 slots; the backend and CLI used
two Bun workers. Other worktrees were validating concurrently; an observed
host load average was 44.35. Contention is a possible contributor, not an
established cause.

The complete aggregate retained these failures:

| Owner | Failure |
| --- | --- |
| `tests/unit/host-test-scheduler.test.ts` | Resource exclusion/queue/frozen-budget case exceeded its five-second deadline (6551.39 ms). |
| `packages/protocol/src/node/transcript-budget.test.ts` | Quadratic-reference comparison exceeded five seconds (6078.56 ms). |
| `packages/protocol/src/schedule-time.test.ts` | Existing forward-search performance assertion measured 2609.55 ms against less than 2000 ms. The forward-search implementation and assertion were unchanged. |
| `apps/web/src/components/native-agent/AgentNativeTab.test.tsx` | Legacy workflow dataset fallback and pending-device-login rehydration exceeded five seconds (5752.99 and 5645.34 ms). |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | Bounded-concurrency fixture exceeded 120 seconds (120663.19 ms); see [0627](../native-agents-and-transcripts/0627-long-transcript-fixture-aggregate-timeout.md). |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | SVG boundary case received `render_timeout` instead of `package_size_exceeded` (9743.03 ms). |
| `apps/backend/src/core/opencode-coordinator-research-live.test.ts` | Research-server registration exceeded 40 seconds; see [0785](../coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md). |
| `packages/cli/tests/command-surface.test.ts` | zsh completion subprocess returned status null; `zsh` was absent from PATH on this host. |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | Default sandbox writes and coordinator sandbox reads failed in their vendor CLI fixtures. |
| `bridges/claude-bridge/src/sdk-compatibility.test.ts` | Streaming-input/background-process compatibility failed. |
| `bridges/claude-bridge/src/services/session-manager-lifecycle.test.ts` | Session-without-plan-or-client-key metadata case failed. |
| `bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts` | Escalation restart count remained one at its observation deadline; see [0214](../agent-bridges/0214-codex-escalation-restart-backstop-timing.md). |

No scheduler regression test failed in the aggregate. Backend reported
11318 passed and two failures; web 9669 passed and three failures; protocol
1867 passed and two failures; CLI 262 passed and one failure. Root reported
3416 passed and one failure. The desktop, public web, toolchain, Pi, Cursor,
ACP and protocol-lockfile groups passed.

The host-scheduler and transcript-budget owners passed together, unchanged,
with `mise run test:logged -- --name aggregate-timing-owners -- bun test ./tests/unit/host-test-scheduler.test.ts ./packages/protocol/src/node/transcript-budget.test.ts --parallel=1 --only-failures`
(8.0 s). The complete timing owner, including its new reverse-search
coverage, passed with
`mise run test:logged -- --name focused-protocol-regressions -- bun test ./packages/protocol/src/schedule-time.test.ts --parallel=1`
(1.7 s). Other aggregate failures were not rerun individually in this change;
their presence alone does not establish a new flaky classification.

## CLI scenarios

`mise run test:logged -- --name cli-scenarios -- mise run test:cli:scenarios`
ran all nine credential-free scenarios. Eight passed; `local-lifecycle`
failed at `stale config set` because JSON mode printed zero stdout lines.
The run took 185.8 s. The complete unchanged scenario passed separately:
`mise run test:logged -- --name cli-local-lifecycle-rerun -- mise run test:cli:scenarios --scenario local-lifecycle`
(16.6 s). The scenario's cause remains unconfirmed; no timeout, assertion or
skip was changed.

## Browser infrastructure

The initial `mise run test:browser` stopped in fixture ownership checking
with `fetch failed: other side closed`. Dedicated ports 25422 and 25423
avoided reuse of another checkout's default-port server. The next attempt
found the required Chromium headless binary missing. Installing the pinned
browser with `bunx playwright install chromium` succeeded.

After installation, the component suite collected 842 cases and began with six
workers. Unrelated fixtures rendered blank pages: the first account-status
trace contains 68 console resource errors, all `net::ERR_NETWORK_CHANGED`,
while loading local Vite modules. The run was interrupted with SIGINT after
the repeated resource failures were established, rather than waiting for every
blank page to time out. It reported 34 passed, 37 skipped, ten failed, six
interrupted and 755 not run (142.3 s, exit 130). This is incomplete browser evidence, not a passing
browser check. The chained public-site browser suite did not start.

The complete unchanged account-status and add-project fixture owners then
passed across both viewport projects with one worker (25.0 s):
`ORKESTRATOR_E2E_PORT=25422 mise run test:logged -- --name browser-fixture-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentAccountStatus.spec.ts e2e/AddProjectDialog.spec.ts --workers=1`.
This supports transient fixture loading failures for those owners, without
establishing a cause for every interrupted aggregate case.

The public-site suite passed independently (28.0 s):
`ORKESTRATOR_PUBLIC_E2E_PORT=25423 mise run test:logged -- --name public-site-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts --workers=1`.

An earlier focused Settings worker also exited with infrastructure status 1
after 3.7 s and no assertion diagnostics. Its unchanged complete owner passed
on rerun (24.2 s), and the final Settings owner passed again (6.9 s). No
specific crash signal or cause was reported, so none is inferred here.

## Passing focused and static checks

- `mise run check`: formatting, lint and complete repository typechecks passed.
- Final backend owners: scheduled-job service, coordinator schedules, public
  schedule API and agent tools passed together with `--parallel=2` (28.5 s).
- Final Settings component owner passed (6.9 s).
- Final CLI schedule payload owner passed (0.3 s).
- Complete timing owner and the unchanged timing-dependent owners passed as
  described above.

Evidence remains in the private host temporary directories
`orkestrator-test-run.DFO9nz` (aggregate), `orkestrator-test-run.oJaZlE`
(CLI scenarios), `orkestrator-test-run.IuDegP` (undiagnosed Settings worker)
and `orkestrator-test-run.be8qTT` (browser). Browser traces are under
`output/playwright/test-results/`; CLI manifests are under
`output/cli-scenarios/`. These generated artifacts are not committed.
