# Tab teardown hanging-delete case exceeds its 250 ms elapsed bound under load

- **ID:** 0460
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `durable tab teardown commands > times out a hanging provider delete without blocking other intents`
- **File:** `apps/backend/src/core/commands-state-sync.test.ts:3184`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on
  branch `qualify-annotation-live-implement-0330a0bacc01` (`50c26708`; the
  change touches only the dev:test harness, e2e specs and docs, not tab
  teardown)
- **Worker configuration:** the four default `mise run test` groups
  concurrently on a heavily loaded macOS host; the workspace group took
  691.5 s and the backend package 592.2 s (9,014 passed, 4 failed).
- **Failure:** `expect(performance.now() - startedAt).toBeLessThan(250)`
  received 264.16 ms; the test took 279.49 ms. The reconcile itself resolved
  `{ completed: 1 }` as expected; only the wall-clock bound failed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
- **Isolated rerun:**
  `mise run test:logged -- --name iso-state-sync -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-state-sync.test.ts --parallel=1 --only-failures`
  passed (12.6 s for the file; 170 passed alone without the preload too).

## Current assessment

A wall-clock bound of 250 ms around a 20 ms teardown timeout leaves little
headroom on a loaded host. The bound exists to prove that a hanging delete
does not block other intents, so a fix should assert ordering (the other
intent completed before the hanging one settled) rather than raise the
number. Not changed here.
