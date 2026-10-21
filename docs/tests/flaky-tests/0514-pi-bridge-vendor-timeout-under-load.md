# Pi bridge vendoring timeout under concurrent host load

- **ID:** 0514
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure`
- **File:** `tests/unit/pi-bridge-vendor.test.ts:21`
- **Original command:** `mise run test:logged -- --name command-nodes-final -- mise run test` (complete non-iOS suite) while another worktree's session was running its own `pi-bridge-vendor` rerun on the same host.
- **Worker configuration:** default `scripts/test-all.ts` planning; the suite took 1394 s instead of the usual ~600 s because of the concurrent load.
- **Failure:** the test hit its 30 000 ms timeout.
- **Suite counts:** root group reported 1 fail (plus two inheritance-guard failures that were real and fixed by recording `StorageNodes`).
- **Isolated rerun:** `bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1` passed (4 pass, 0 fail); the whole root group then passed (`command-nodes-root`, 57.5 s).
- **Evidence:** `orkestrator-test-run.9DCaI0` under the host temporary directory.
- **Hypothesis:** staging and loading the Pi runtime closure exceeds 30 s when the host is saturated, here by a second session's vendoring test. The change under test (command nodes) does not touch the Pi bridge or its vendoring. No implementation, assertion, timeout or skip changed.
