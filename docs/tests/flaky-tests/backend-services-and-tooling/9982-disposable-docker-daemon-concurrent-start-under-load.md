# Disposable Docker daemon concurrent start leaves one launch not running in the aggregate

- **ID:** 9982
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `14df965440e658e09a7b3ce03530bc1781ac2b01`.
- **Observed head:** `adoption-follow-ups-0b2001052718-r1` at `afb5369d1`.
  The branch changes backend read cancellation (node routing, node link,
  provider reads, transcript artifacts, the gateway), their tests, one
  desktop IPC test and docs. It does not touch
  `scripts/disposable-docker-daemon.ts` or this test.
- **File:** `tests/unit/disposable-docker-daemon.test.ts:458`
- **Test:** `review regressions > concurrent start and restart cannot reap an in-flight launch`
- **Failure:** `expect(isRunning(b)).toBe(true)`, Expected true, Received
  false (85.84 ms). The first launch, held at its `tools` gate while the
  second started, was running; the second was not.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite at its default worker counts) on Linux x86_64, 16 cores, on a
  host shared with other worktrees' runs.
- **Suite counts:** the workspace group (backend, web, desktop, CLI, protocol,
  toolchain, web-public) passed; bridges and the codex protocol lockfile
  passed; the root and agent-support group failed only this case.
- **Isolated rerun:** the aggregate runner's automatic rerun of the unchanged
  owning file reported `PASSED ALONE (3.4s)`.

## Hypothesis

Unconfirmed. The second `startInstance` runs while the first is held inside
its launch; under load its stub daemon may not have been observed as running
by the time `isRunning` checks it, or the start lock the test guards against
may let one launch's cleanup see the other as stale. Reproduce it first (for
example under `scripts/test-under-contention.ts` with `--rerun-each`) and
record which instance was reaped and why before changing the test; do not
loosen the assertion.
