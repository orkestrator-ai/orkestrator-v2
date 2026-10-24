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
