# Codex stored-login reload misses its 500 ms notice deadline in the aggregate

- **ID:** 5880
- **Status:** open
- **Date observed:** 2026-11-05
- **Test/file:** `stored account reload admission > clears a refused API-key notice after external credential replacement via stored-login with apiKey`, bridges/codex-bridge/src/app-server-runtime-account-reload.test.ts:91.
- **Original command:** `mise run test` during review preparation of the E17 dead code branch (`f0ec7cd14`), Linux, Bun 1.4.4, group `codex-bridge:test:bridge`, `bun test v1.4.4 1x PARALLEL`. The bridges group ran for 1,226.9 s.
- **Failure:** `error: external replacement did not clear refused notice` from `waitUntil` (`app-server-runtime-test-harness.ts:57`, default 500 ms), with the test failing at 511.74 ms.
- **Isolated rerun:** the owning file alone passed once through `test:logged` at `f0ec7cd14` (0.9 s). On the same branch rebased onto `af2e566e5` it passed eight times out of eight in sequence and sixteen times out of sixteen at once, with a host load average of about 50 (11 pass, 0 fail in the run whose counts were read).
- **Hypothesis:** this variant clears the notice only after the engine restarts its child to reload the stored login (`h.children` reaches 2), so it has more work to finish inside the shared 500 ms wall-clock wait than the other variants. The cause is unconfirmed: the parallel stress above did not reproduce the failure.
- **Attribution:** the failure triage marked this related because the test imports `packages/protocol/src/log-vocabulary/bridge.ts`, which that branch changed by removing `raw-log.write-failed`. The test does not use that event.
- **Not measured:** host load and child restart time during the original run.
