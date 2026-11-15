# Container server startup exceeds its aggregate deadline

- **ID:** 0750
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** In-container Codex start-up through fake Docker exceeded Bun's 5 s default; the next Cursor case then reached the removed fixture socket of the cut-off test.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
