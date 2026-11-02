# Abandoned upload expiry cleanup races a fixed wait

- **ID:** 0821
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `abandoned uploads expire and remove worktree temporary files`
- **File:** `apps/backend/src/core/nodes/node-files.test.ts:343`
- **Change under test:** Multi Review dispatch recovery and result-reminder coverage, commits `8410fe29c` and `1834edeaa`.
- **Original command:** `mise run test:logged -- --name default-suite -- mise run test`.
- **Aggregate result:** the backend reported 11,184 passed and two failed. One failure was an older fan-out fixture missing request acceptance proof, corrected separately. The upload-expiry failure found a `.orkestrator-upload-` temporary file after the test's fixed 30 ms wait with a 10 ms expiry (159.02 ms test duration). The complete aggregate ran for 1,013.1 s, using the default workspace/root/bridge/protocol reservations of 4/1/2/1.
- **Unchanged owner rerun:** `mise run test:logged -- --name upload-expiry-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-files.test.ts --parallel=1 --only-failures` passed (exit 0, 0.8 s).
- **Evidence:** `orkestrator-test-run.MJ1vdw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.pnyrDq/`, under the host temporary directory.
- **Hypothesis:** the expiry timer and asynchronous temporary-file removal did not finish before the fixed assertion wait under aggregate contention. The isolated pass establishes intermittence; the cause is not established. No upload implementation, assertion, timeout, or skip was changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the fixed 30 ms wait against a 10 ms expiry is still at `node-files.test.ts:340`. The owner passed alone today (14/14, 2.0 s; Bun 1.4.4).
- **Next step:** poll (bounded) until the temporary file is gone, instead of the fixed wait.

## Safe error formatting second review — 2026-11-02

Preparation's `mise run test` at `de952cc0accc820c6d57425323428cc993794a54`
repeated the remaining-upload assertion at line 424 (67.02 ms). Backend:
13,006 passed, 97 skipped, five failed across 870 files (440.83 s), three
isolated workers. Original evidence is preserved at
`.orkestrator/review-artifacts/review-validation-b03e0cc0-820a-4723-8d36-20d1666dfe82/validation-04.stdout.txt`.

The complete unchanged owner passed on the fix branch as part of
`mise run test:logged -- --name r5-round2-recorded-owners -- bun test --cwd apps/backend ./tests/container-readiness.test.ts ./src/core/commands-agent-tools.test.ts ./tests/codex-subagent-cards.test.ts ./src/core/nodes/node-files.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures`
(exit zero, 14.2 s; passing per-file counts were not retained by the runner).

A detached `origin/main` worktree at `9dbd7f1cc9981789ab352056bea84a1007c99959`
installed its own dependencies with `mise exec -- bun install --frozen-lockfile`.
`mise run test:logged -- --name r5-round2-main-upload -- bun test --cwd apps/backend ./src/core/nodes/node-files.test.ts --parallel=1 --only-failures`
passed (0.5 s). The same owner with `--test-name-pattern 'abandoned uploads expire'`
and `--rerun-each=50` passed (2.3 s), as did `--rerun-each=200` (8.3 s), under
names `r5-round2-main-upload-repeat` and `r5-round2-main-upload-repeat-200`.

The owner and implementation match main, but these passes do not reproduce the
preparation failure on main or establish its cause. The failure's independence
from the logging change remains unproven. No unrelated implementation,
assertion, wait, timeout, or skip was changed; this case remains open.
