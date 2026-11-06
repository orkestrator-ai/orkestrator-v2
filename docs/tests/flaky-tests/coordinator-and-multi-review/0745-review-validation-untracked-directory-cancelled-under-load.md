# records untracked directory entries with a trailing slash (apps/backend/src/core/review-validation-worker.test.ts)

- **ID:** 0745
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Original command:** `mise run test` (non-iOS aggregate) on the `todo-0011-runtime-state-ownership` branch, node mbp3 (macOS, Apple Silicon), while `mise run test:agent:browser:isolated` was running on the same host.
- **Worker configuration:** default aggregate groups (workspace, root and agent-support, bridges, codex protocol lockfile) in parallel; backend `test:workspace` package script.
- **Failure:** `expect(done.status).toBe("completed")` at `review-validation-worker.test.ts:340` received `"cancelled"`, reported as an unhandled error between tests (duration: 8,370.16 ms).
- **Suite counts:** backend 10,444 tests across 608 files: 10,310 passed, 115 skipped, 19 failed. The other 18 failures were real (contexts without a `runtime`, fixed in the same branch) or the known OpenCode 1.19.4-vs-1.19.0 conformance mismatch.
- **Isolated rerun:** `mise run test:logged -- --name rvw-1 -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --parallel=1` → passed, twice (42.9 s and 42.4 s).
- **Hypothesis:** the validation run's shell script is cancelled by its own deadline when the host is saturated (the isolated browser suite and the full aggregate ran together); the run took 8.4 s in the aggregate against about 42 s for the whole file alone. The branch does not touch the review validation worker. Not yet reproduced under a controlled load.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. Same owner as the open validation-worker deadline cases [0227](0227-validation-cooperative-groups-incomplete.md), [0260](0260-validation-worker-stopped-output-empty.md) and [0302](0302-validation-worker-progress-watchdog-timeout.md). The later change to the owner (#1247, 162584a52) touches only artifact verification, not this case.
- **Next step:** on recurrence, record why the run was cancelled (its own deadline or an outside stop). If it is the deadline, fold this case into 0302.

### Resolution — 2026-11-06

- **Root cause:** the harness deadline was shorter than the test's own wait. The
  test waits up to 12 s (`waitFor(..., 12_000)`) under Bun's 5 s default. Only
  two paths give a run `cancelled`: an explicit cancel (which the test's
  `afterEach` issues for every fixture) and a dead worker. When Bun timed the
  test out, `afterEach` cancelled the still-live run, and Bun also kills dangling
  child processes. The test body was still awaiting, and it then read
  `cancelled`, which was reported as an error between tests at 8.4 s. The test
  itself never cancels.
- **Fix (test only):** `setDefaultTimeout(30_000)` in
  `apps/backend/src/core/review-validation-worker.test.ts`, registered before
  `afterEach`. The harness budget now covers the test's 12 s observation bound.
  No assertion changed.
- **Reproduced:** partly. With `--timeout=150` the test timed out, its hook timed
  out and Bun killed a dangling worker. The exact `cancelled` read needs the
  timeout to land between `afterEach`'s cancel and the late read, which was not
  produced on demand.
- **Verification:** `coord-rvw-stress` under one-core contention (this test,
  `--rerun-each=5`): pass. Complete owner alone (`coord-rvw-file2`): 66/66 pass.
