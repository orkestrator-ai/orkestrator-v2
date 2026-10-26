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
