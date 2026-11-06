# Workspace Git mirror fixture setup deadline

- **ID:** 6081
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `fallback to the ordinary clone > no variable means an image or runtime without a mirror, and nothing changes`
- **File:** `tests/unit/workspace-setup-git-mirror.test.ts:119`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** root and agent-support group, `1x PARALLEL`; workspace and bridge groups ran concurrently. A component browser suite was also running on the host.
- **Failure:** a beforeEach/afterEach hook exceeded Bun's 5 s deadline after 5,082.50 ms. The stack reached the fixture's `git commit` helper at line 45.
- **Suite counts:** root and agent-support group: 3,638 passed, 3 failed, 3,641 total across 185 files in 477.66 s. The other two failures were egress qualification and flake-index metadata; they are not attributed to this case.
- **Evidence:** the current worktree's default-suite rerun, `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.aO75xe/root-and-agent-support-tests.log` (compressed after aggregate finalization).
- **Isolated rerun:** `mise run test:logged -- --name git-mirror-triage -- bun test ./tests/unit/workspace-setup-git-mirror.test.ts --parallel=1 --only-failures` passed the entire owning file, exit 0, in 54.6 s. Passing output was deleted by the logged runner; individual passing counts were not retained.
- **Scope:** this branch changes neither the owning test nor the workspace setup/mirror implementation. No test or timeout was loosened.
- **Hypothesis:** fixture Git setup exceeded its wall-clock budget during concurrent validation. The isolated pass establishes an intermittent failure, but does not establish its underlying cause.

### Resolution — 2026-11-06

- **Root cause:** the hook's budget was too small for its real Git work; no
  race was involved. The `beforeEach` fixture runs about a dozen real Git
  processes for every case: a bare init, a config write, a clone, a checkout
  and two add/commit/push rounds over `file://`, each push starting
  `receive-pack`. All of them are synchronous `spawnSync` calls under Bun's
  generic five-second hook deadline. The owner took 54.6 s alone on macOS for
  about nineteen cases (about 3 s each, hook included), so a saturated
  aggregate pushed the hook past five seconds at its `git commit` step,
  which matches the recorded stack.
- **Fix:** `tests/unit/workspace-setup-git-mirror.test.ts` sets an explicit
  30 s file budget with `setDefaultTimeout`, which Bun applies to the file's
  hooks as well as its tests. No assertion or fixture step changed.
- **Reproduction:** the unchanged file with `--timeout 60` failed with "a
  beforeEach/afterEach hook timed out for this test", the recorded failure
  kind at a shortened deadline. The five-second deadline was not reached on
  this Linux host, where a whole case takes about 0.2 s.
- **Verification:** `mise run test:logged -- --name env-git-mirror-stress --
  bun test tests/unit/workspace-setup-git-mirror.test.ts --parallel=2
  --rerun-each=10`: PASS in 63.6 s at load average 13–17.
