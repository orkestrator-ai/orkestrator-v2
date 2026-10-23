# `standalone backend service` process-shutdown timeouts (`apps/backend/tests/standalone.test.ts`)

- **ID:** 0058
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Affected tests:** `drains an active local server process tree before exiting` and `exits without a leftover listener when environment-managed Serve setup fails`.
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the backend workspace ran `bun test src tests --parallel=2` while the web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** both cases exhausted Bun's 5,000 ms per-test budget, at 5,001.05 ms and 5,000.08 ms respectively. Bun also reported two between-test errors after killing the timed-out child processes.
- **Suite counts:** backend package: 1,705 passed, 2 failed, and 2 between-test errors across 55 files.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/standalone.test.ts --parallel 2>&1 | tee /tmp/orkestrator-fix-backend-standalone-isolated.log` from `apps/backend` -> 8 passed, 0 failed, 36 assertions in 15.40 seconds; the two affected cases passed in 1,928.31 ms and 1,701.20 ms.
- **Earlier occurrence (2026-08-14):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-c4ce823f-full-tests.log` at `c4ce823fb218e0f858115c0e0ada81203998c10a` ran the backend workspace as `bun test src tests --parallel=2` alongside the other aggregate groups. `exits without a leftover listener when environment-managed Serve setup fails` exceeded Bun's 5,000 ms outer budget (5,001.28 ms), after which the runner killed three dangling processes and the following Serve rejection case produced a between-test assertion because its child stderr was empty. The backend package reported 1,696 total, 1,695 passed, 1 failed, and 1 between-test error. The immediate isolated rerun, `set -o pipefail; bun test ./tests/standalone.test.ts --parallel 2>&1 | tee /tmp/orkestrator-c4ce823f-standalone-isolated.log`, passed all 8 tests with 36 assertions in 21.05 seconds; the affected case passed in 2,188.24 ms.
- **Hypothesis:** both tests start and stop real child-process trees and remained well below their outer budget without the other three validation groups competing for process startup. The aggregate log contains no failed functional assertion before either budget expired, and the reviewed repository-settings change does not touch backend lifecycle code.
