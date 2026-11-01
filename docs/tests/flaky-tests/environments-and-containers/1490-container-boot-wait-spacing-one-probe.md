# A probe that comes back early is spaced, one probe in the budget (apps/backend/tests/container-readiness.test.ts)

- **ID:** 1490
- **Status:** open
- **Test:** `bounded in-container boot wait > a probe that comes back early without a final state is spaced, not repeated at once`
- **Date observed:** 2026-10-31
- **Original command:** `mise run test`
- **Worker configuration:** backend workspace `bun test` at 4x parallel, on mbp3 with other workers running at the same time
- **Failure:** `expect(execs).toBeGreaterThanOrEqual(2)` received 1 (duration: 2.16 s)
- **Suite counts:** backend 11778 total, 11673 passed, 103 skipped, 2 failed
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/container-readiness.test.ts` from `apps/backend`, three times → passed each time (20 pass, 0 fail)
- **Hypothesis:** the test gives the wait a 450 ms budget and needs two probes to fit inside it, each spawning a fake `docker` shell script. The failing case took 2.16 s in all, so on a loaded host the first probe used up the budget. Not reproduced under controlled load. The same test passed in the run before it. The change on the branch (retiring the legacy close fallback) does not touch this code.

## Provider parity main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test`, merging main at `751b971623` into `agent-provider-parity-b3e549e90812-r1`.
- **Worker configuration:** workspace/root/bridges/protocol reservations 6/1/2/1; backend 4x parallel, Bun 1.4.4. About 182 seconds waiting for the host scheduler, 710.6 seconds overall.
- **Failure:** the same bounded-wait case expected at least two probes and received one (452.65 ms). Backend counts: 11,883 passed, 103 skipped and four failed across 11,990 tests in 812 files (266.84 s).
- **First unchanged owner rerun:** `mise run test:logged -- --name merge-container-readiness-owner -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` also failed while the aggregate was running: 19 passed, one failed (11.3 s); the case took 545.24 ms and recorded one probe.
- **After the aggregate completed:** `mise run test:logged -- --name merge-container-readiness-after-aggregate -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 (7.6 s).
- **Evidence:** `orkestrator-test-run.LzSOdM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, enclosing `orkestrator-test-run.WvH9mv/merge-default-tests.log.gz`, and the first owner rerun in `orkestrator-test-run.cSDOnQ`, under the host temporary directory.
- **Assessment:** host contention is consistent with the result, but remains unconfirmed. The owner, readiness implementation and lifecycle fixtures matched the original main merge parent exactly; no implementation, assertion, deadline or skip changed. The aggregate remains non-green.

## Safe error formatting review recurrence — 2026-11-01

- **Original command:** `mise run test` against `ae4084d15c71e0e0644530b9c38b581bb9b280be`; captured package `.orkestrator/review-artifacts/review-validation-3ad92a25-6e3a-4d7c-876c-260073a2f6f9/review-package-889ea18990f90016b53a23fec9903ab237ce65d41578ca56458956ddd95071d4.json`.
- **Worker configuration:** concurrent workspace/root/bridge/protocol groups, reservations 5/1/2/1; the captured backend parallel setting is not printed in the retained output.
- **Failure:** the same test expected at least two probes but received one at line 441 (476.96 ms, 450 ms deadline). Workspace was the sole failing group; root, bridges and protocol lockfile passed.
- **Suite counts:** backend 13,008 passed, 97 skipped, one failed across 13,106 tests in 870 files (272.40 s).
- **Evidence:** original `validation-04.stdout.txt` lines 3482–3498 in that artifact directory; output is preserved unchanged.
- **Isolated rerun:** `mise run test:logged -- --name r5-readiness-owner -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --parallel=1 --only-failures` passed (exit 0, 6.8 s) without changing this test or the readiness implementation.
- **Assessment:** credible recurrence of the existing timing flake. This establishes isolated success, not its cause; no assertion, deadline or skip was changed. The exact failed command was rerun through `mise run test:logged -- --name r5-default-suite-rerun -- mise run test` and passed all four groups (exit 0, 338.5 s). No root-cause fix to this existing flake is claimed.
