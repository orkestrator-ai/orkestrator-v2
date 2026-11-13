# Agent usage fixture misses its browser deadline

- **ID:** 0749
- **Status:** open
- **Date observed:** 2026-10-24, node mbp3
- **Tests:** `subagent compact usage fits alongside the header and remains accessible after reload`; `task-group compact usage fits alongside the header and remains accessible after reload`.
- **Owner:** `e2e/AgentUsage.spec.ts:38`.
- **Original command:** `mise run test:logged -- --name merge-browser-fixed -- mise run test:browser`, nine workers alongside repository and Electron validation on the shared host.
- **Failure:** both mobile cases exceeded 30,000 ms; suite counts: 577 passed, 102 skipped, seven failed (694.4 s).
- **Complete unchanged owner:** the one-worker command containing six complete owner files, recorded in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md), passed all four AgentUsage cases. Combined counts: twenty passed, four skipped, two unrelated AgentLaunchDialog failures, 127.0 s.
- **Evidence:** `orkestrator-test-run.BIyzun/merge-browser-fixed.log.gz` and `orkestrator-test-run.ngoXeT/merge-browser-owners.log.gz` below the host temporary directory.
- **Hypothesis:** browser fixture startup or shared-host contention; no cause established. No assertion, deadline, skip or implementation changed in the owner.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The nine-worker `mise run test:browser` run repeated failures in this owner; the complete unchanged owner passed across both viewports with one worker in 20.8 s. Command: `ORKESTRATOR_E2E_PORT=54733 mise run test:logged -- --name design-links-browser-owner-usage -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts --workers=1 --output output/playwright/design-links-owner-usage`. The aggregate had 496 passes, 89 failures and 101 skips. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the parents and original evidence. No assertion, deadline or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** two observations, both in nine-worker browser suites (the second had 89 failures). The owner passes with one worker.
- **Next step:** on recurrence, read the trace to see whether the 30 s went to fixture startup or to the assertion. If it was startup, fold this case into [0382](0382-component-browser-parallel-load.md).


## Shared Codex state review fixes — 2026-10-26

Both mobile cases reached 30 seconds again in the nine-worker component browser suite on `74841142b`. The complete unchanged owner passed all four cases with one worker in 69.3 s: `ORKESTRATOR_E2E_PORT=62459 mise run test:logged -- --name codex-auth-owner-agentusage -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts --workers=1 --output output/playwright/codex-auth-owner-agentusage`. The repository suite and other browser checks were running concurrently. Original command, suite evidence and broader results are in [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md); no cause or fix is established.

## Comparison-base review validation — 2026-10-29

The exact preparation-command rerun,
`mise run test:logged -- --name browser -- mise run test:browser`, again timed
out both mobile cases during reload (30 seconds each). The separate complete
owner command,
`mise run test:logged -- --name unrelated-browser-usage-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts --workers=1 --output output/playwright/diff-base-usage-owner`,
also timed out all four cases (exit 1, 148.1 seconds logged) while the broad
browser suite was still running on the shared fixture server. This observation
therefore does not establish an isolated pass or a cause; the owner remains
unresolved. No usage-card implementation, assertion, timeout or skip changed.
The comparison-base flow passed separately on both viewports before this run.

Evidence: `/tmp/orkestrator-test-run.uKKt7U/unrelated-browser-usage-owner.log.gz`
and its `summary.json`; the broad rerun logs are under
`/tmp/orkestrator-test-run.OKCGVn/` (compressed on completion). Traces for the
owner are under `output/playwright/diff-base-usage-owner/`.

The broad rerun exited 1 at its 1,800,000 ms group deadline (1,800.1 seconds
logged), after starting 960 of 1,040 component cases and reporting 22 failures
outside the comparison-base change. There was no completed suite summary;
counts of started cases are not counts of passes. The new comparison-base
scenario ran on both mobile and desktop without a reported failure, and its
separate targeted two-viewport run passed. The browser command's initial e2e
typecheck passed (2,047 files). Its chained public-site suite was not reached.
Final evidence is `/tmp/orkestrator-test-run.OKCGVn/browser.log.gz` and
`/tmp/orkestrator-test-run.OKCGVn/summary.json`. This broad command remains
incomplete/non-green; unrelated browser failures have not been reclassified as
flakes or repaired by this change.

## Coordinator C3 review fixes — 2026-11-05

Both mobile cases failed again in the two-worker component suite, on separate
fixture ports from other checkouts. The owner rerun on another dedicated port
failed all four AgentUsage cases (30-second reload/locator timeouts), while all
eight ChangeTracking cases passed. The default suite was also running.
This confirms recurrence, not an isolated pass or a root cause.

Commands, counts and evidence are recorded in
[6660](6660-change-tracking-image-reload.md). No usage implementation or test changed.

## Coordinator unavailable-platform review — 2026-11-06

Both mobile compact-usage cases exceeded the 30 s test deadline, at the usage-duration assertion or header focus.

The browser repeat used five workers and a free fixture port. It named nine failures and stopped at the 1800000 ms group deadline after starting 708 of 1596 cases; complete pass totals were not available. Original command: `ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser`.

The unchanged complete owner passed alone, exit 0, in 31.6 s:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-agent-usage-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts --workers=1 --output output/agent-testing/review-address-owners/usage
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`. Passing
output was deleted by the logged runner, so individual rerun counts were not
retained. This establishes intermittence, not its cause. No assertion, timeout
or implementation was changed to hide the failure; the broad check remains
non-green.

## Recurrence (2026-11-13)

Base `17d28238c098b4443d1289df5c4ed75e7cc2802e` (recurrence check: open);
branch `remove-dead-bridge-be98778b92d1-r1` at `5d3ddf201`, which does not
touch usage components. Both mobile `AgentUsage.spec.ts:38` cases exceeded
30 s in a deadline-killed `mise run test:browser` at load about 85 and again
in a seven-owner rerun at load about 60 (116 others passed). The unchanged
owner then passed alone with one worker:
`mise run test:logged -- --name agent-usage-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts --workers=1`
(49.9 s). Details in [9988](../design-canvas-and-artifacts/9988-design-launch-old-backend-reload-timeout.md).
