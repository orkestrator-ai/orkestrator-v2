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

### Exact aggregate rerun outcome

`mise run test:logged -- --name r5-round2-default-suite -- mise run test`
finished with exit 1 (919.0 s, including about 663 s of admission wait).
Workspace, root and protocol groups passed. All five original backend assertion
failures passed in this run. The sole failing group was bridges: the Codex
catalogue disposal assertion recorded in case 0791. No root-cause fix to these
existing timing cases is claimed. Final status evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kkqsTX/summary.json`;
compressed group logs are in that same directory. The enclosing log is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.TLjndR/r5-round2-default-suite.log.gz`.


## Task 1202 background-work review repair — 2026-11-02

The exact default-suite retry used `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1
mise run test:logged -- --name address-default-suite-concurrent -- mise run test`
with workspace/root/bridge/protocol grants of 6/1/2/1. The ordinary retry was
cancelled while queued behind another worktree; the documented concurrency
option admitted all groups. Original preparation artifacts were preserved.
Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.WXZCOJ/`
(group logs; compressed on failure), outer log in `orkestrator-test-run.Vufyx3`.

The temporary-upload assertion recurred at line 424 (106.27 ms).
`mise run test:logged -- --name address-upload-rerun -- bun test --cwd apps/backend ./src/core/nodes/node-files.test.ts --parallel=1 --only-failures`
passed the complete unchanged owner (1.5 s). A detached `origin/main` at
`38d55ee146c5bc29bdfb338c4f93f9de5f0cd787`, with its own frozen install, passed
50 repeats of the failing test (`address-main-upload`, 2.4 s). These passes
establish intermittence, not failure independence; the cause remains unproven.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.

## Coordinator environment-choice review, 2026-11-03

Preparation at `d2efad0d6` ran `mise run test` and failed the unchanged
`abandoned uploads expire and remove worktree temporary files` at line 424
(expected false, received true, 57.04 ms). The original output remains in
`.orkestrator/review-artifacts/review-validation-b82eab29-3f18-42ce-8dd3-4d2e4a59a7a0/validation-04.stdout.txt`.
The workspace and bridge groups failed; root and protocol groups passed.
Preparation used the package scripts' configured parallel worker counts.

The complete owner passed alone through
`mise run test:logged -- --name upload-expiry-owner -- bun test --cwd apps/backend ./src/core/nodes/node-files.test.ts --parallel=1 --only-failures`
(exit 0, 0.8 s). A detached `origin/main` at `eda57e938`, with its own frozen
install, also passed this owner in 20 repeats in a three-owner run (680 pass,
20 fail, all failures in PreviewUpstreamPool). This establishes intermittence,
not target-branch reproduction of this exact failure. No upload code changed.

## E14 review repair, 2026-11-05

Preparation at `a89e2e827` repeated the unchanged expiry assertion (expected
false, received true, 36.90 ms) in `mise run test`, using package-configured
parallel workers. Original evidence: `.orkestrator/review-artifacts/review-validation-81b1b0a7-2350-4eb7-aacc-cbbe84a9b965/validation-04.stdout.txt`.
The consolidated review recorded 31,356 pass / 143 skipped / 4 failures.
`mise run test:logged -- --name address-upload-expiry -- bun test --cwd apps/backend src/core/nodes/node-files.test.ts --parallel=1 --only-failures`
passed the complete unchanged owner (exit 0, 0.4 s). No expiry implementation
or assertion changed; the fixed wait remains a suspected contention race.
The preparation triage marks this related by its transitive import of the
changed Docker log vocabulary, so this pass alone does not establish causality.
