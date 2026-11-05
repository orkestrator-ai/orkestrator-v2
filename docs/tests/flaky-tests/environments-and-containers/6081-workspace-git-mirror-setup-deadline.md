# Workspace Git mirror fixture setup deadline

- **ID:** 6081
- **Status:** open
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
