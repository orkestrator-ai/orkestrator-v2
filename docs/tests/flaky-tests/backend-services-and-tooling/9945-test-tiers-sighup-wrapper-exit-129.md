# Package tier wrapper exits 129 on a forwarded SIGHUP under load (`tests/unit/test-tiers.test.ts`)

- **ID:** 9945
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`.
- **Observed head:** branch `coordinator-gap-followups-9822bf38253f-r1` at
  `6d10e5dcb` (coordinator gap-tools harness fixes). It does not touch
  `scripts/bun-test-tier.ts` or `tests/unit/test-tiers.test.ts`.
- **Test:** `package tier wrapper > SIGHUP reaches the child and waits for its cleanup`
  (`tests/unit/test-tiers.test.ts:405`).
- **Failure:** `expect(exited).toBe(0)` received `129` after 108.33 ms: the
  wrapper's exit status, which it takes from its `bun test` child, was a
  SIGHUP death (128 + 1) rather than the fixture handler's clean exit 0. The
  ready file had been written, so the fixture's `process.on("SIGHUP")` was
  installed before the signal was sent.
- **Original command:** `mise run test:logged -- --name root-focused -- bun test tests/unit/test-all.test.ts tests/unit/test-suite-ownership.test.ts tests/unit/test-tiers.test.ts tests/unit/flaky-tests-index.test.ts tests/unit/docs/instruction-links.test.ts tests/unit/number-claims.test.ts tests/unit/todo-index.test.ts --parallel=4 --only-failures`
  on macOS, with other worktrees' aggregate suites holding the host's test
  slots. 194 of 195 tests passed.
- **Isolated rerun:** `mise run test:logged -- --name test-tiers-alone -- bun test tests/unit/test-tiers.test.ts --parallel=1 --only-failures`
  passed unchanged in 3.0 s.
- **Evidence:** `orkestrator-test-run.I8gTX8/root-focused.log.gz` under the
  host temporary directory.

## Hypothesis

Not established. The wrapper registers its forwarding handlers in the same
tick as the spawn, so the wrapper itself is not the obvious gap. Under load the
signal may reach the `bun test` child while its own runtime, rather than the
fixture's handler, still owns SIGHUP. Treat it as a possible product race in
signal forwarding before raising any budget. No assertion, timeout or skip was
changed.
