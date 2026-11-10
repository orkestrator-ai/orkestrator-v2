# Claude cold-dispatch restart resend answered 503 under aggregate load

- **ID:** 1308
- **Status:** resolved
- **Date observed:** 2026-10-28
- **Test:** `a restarted Claude bridge answers a cold dispatch from disk without registering the session`
- **File:** `apps/backend/tests/claude-cold-dispatch-restart.test.ts:132`
- **Original command:** `mise run test:logged -- --name default-suite -- mise run test` on branch `todo-0430-first-prompt-naming-retries-9581e8c92dc4` (based on `79f3bc97e`), macOS 27.0 arm64, shared host with other sessions' suites (load averages about 17 to 38 shortly after).
- **Failure:** the resend of the never-seen request id (`POST /session/:id/prompt`, `requestId: "never-seen"`) returned 503 instead of 202 after 10,587 ms; the earlier `lost-ack` resend had already returned 410.
- **Isolated rerun:** the complete unchanged owner passed alone (`cold-dispatch`, 0.8 s).
- **Hypothesis:** the restarted bridge was not ready to take a new prompt within the test's wait under host load. Not established. The branch changed only first-prompt rename backoff, which this test does not reach. No assertion, timeout or skip changed. Related: [1147](../aggregate-validation-runs/1147-provider-non-delivery-proof-0223-validation.md), which fixed a 500 on the same resend step.

## 2026-11-02 storage review recurrence

`mise run test:logged -- --name review-default-rerun -- mise run test`
repeated HTTP 503 instead of 202 at line 133 after 11,402.74 ms.
The backend aggregate used the task's parallel worker allocation. The unchanged
complete owner passed in the focused two-file command
`mise run test:logged -- --name isolated-workspace-failures -- bun test --cwd apps/backend ./src/core/design/operations.test.ts ./tests/claude-cold-dispatch-restart.test.ts --parallel=1 --only-failures`
(12.4 s for both owners). The same owners passed in a separately installed
detached origin/main worktree at 38d55ee14 (12.2 s).
This establishes an isolated pass, not an aggregate pass on main.
The host-load/readiness hypothesis remains unproven. No test was loosened.
Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vo7cWm/`.

## Resolution (2026-11-10)

- **Status:** resolved (with [1305](1305-claude-cold-dispatch-restart-admission.md),
  the same failure).
- **Root cause:** a real product race in the Claude bridge's preference lock
  (`bridges/claude-bridge/src/services/session-preferences.ts`). The only
  source of a 503 on `POST /session/:id/prompt` is the claim write's
  `PreferenceLockTimeoutError` (`unavailable`). `withPreferenceFileLock`
  created the lock empty (`open(lockPath, "wx")`) and wrote its owner
  metadata in a second step. The test SIGKILLs the first bridge once the
  claim and in-flight writes have released their lock, but the bridge keeps
  writing preferences after that (title, model and other session updates).
  A kill between the two steps left an empty lock. An ownerless lock is
  recoverable only once it is 30 s stale, so the restarted bridge's claim for
  `never-seen` waited out the 5 s lock timeout and answered 503, which fits the
  10.6–11.4 s test durations. In production, a bridge killed at that moment (a
  SIGKILL, an OOM kill, a container stop) refuses every prompt to that
  session for 30 s.
- **Fix:** `createOwnedFile` writes the owner metadata to a private staging
  file and hard-links it to the lock path. The link fails with `EEXIST`
  while the lock is held, as `wx` did, and the lock never exists without its
  owner. The handle stays on the shared inode, so heartbeats and the
  release's inode check are unchanged. Stale-recovery markers use the same
  helper. A filesystem without hard links falls back to the old order. New
  test `a writer killed while taking the lock leaves nothing that blocks the
  next writer` (`session-preferences.test.ts`): a child process kills itself
  at the new `setBeforeOwnedFilePublishForTesting` seam, and the next writer
  must succeed within a 1 s lock timeout. The claude-bridge `AGENTS.md`
  ownership rule and the comment in `claude-cold-dispatch-restart.test.ts`
  record the rule.
- **Reproduced:** yes, two ways. (1) Writing an empty `<id>.json.lock` beside
  the preference file between the test's `stop()` and `start()` made the
  unchanged owner fail exactly as recorded: the `never-seen` resend got 503
  instead of 202 (7.2 s). (2) The new unit test failed on the `HEAD` lock code
  with the same seam placed between `open` and `writeFile`
  (`PreferenceLockTimeoutError`, 1.05 s), and passes with the fix. A lock
  that is already empty on disk, such as one left by an older bridge, still
  waits out the 30 s rule. The fix stops new ones being created.
- **Stress:** `mise run test:logged -- --name cold-dispatch-1305 -- bun scripts/test-under-contention.ts --burners 4 -- bash -c 'cd apps/backend && for i in $(seq 8); do bun test --preload ../../tests/setup-node.ts ./tests/claude-cold-dispatch-restart.test.ts || exit 1; done'`
  passed 8 of 8 fresh processes (unpinned burners on macOS). The Claude
  bridge suites `session-preferences`, `process-identity`,
  `process-identity-probes`, `session-manager-persistence`,
  `session-manager-lifecycle`, `session-manager-catalog-steer`,
  `session-manager-turn-interruption`, `routes/session` and
  `routes/session-dispatch-cancellation` passed.
