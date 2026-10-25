# Container server startup exceeds its aggregate deadline

- **ID:** 0750
- **Status:** open
- **Date observed:** 2026-10-24, node mbp3
- **Owner:** `apps/backend/tests/commands-registry-servers.test.ts`.
- **Tests:** `Electron backend command registry > starts the in-container Codex bridge with bun and its configured thread limit`; `Electron backend command registry > starts the in-container Cursor SDK bridge`.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, default 4/1/2/1 workspace/root/bridge/protocol plan, two isolated backend workers.
- **Failure:** Codex startup hit 5002.62 ms; subsequent Cursor startup failed in 3546.12 ms with a missing fixture Docker socket after the timeout. The file has the same test code as main.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-registry-servers-owner -- bun test --cwd apps/backend ./tests/commands-registry-servers.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0 in 31.1 s.
- **Suite counts and evidence:** final aggregate counts are in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md); original private log `orkestrator-test-run.AdOl8u/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Hypothesis:** fixture subprocess startup exceeded the five-second budget under shared-host load, then outstanding work crossed fixture cleanup. Cause not established. No assertion, timeout, skip or implementation changed for this recurrence.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** both cases start in-container bridges against fake Docker under Bun's default five seconds, while the same file gives other cases `ASYNC_TEST_BUDGET_MS`. Related: [0196](0196-container-bridge-optional-reachability-timeout.md) (same file, container bridge start timeout) and [0775](../backend-services-and-tooling/0775-claude-bridge-persisted-token-aggregate.md).
- **Next step:** give the in-container bridge start cases the same explicit budget.
