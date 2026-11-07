# Worktree deletion descendant readiness

- **ID:** 9899
- **Status:** resolved
- **Date observed:** 2026-11-07
- **Test:** `delete_environment host cleanup > a hung worktree removal is stopped at its deadline, says why, and a retry finishes it`
- **Owner:** `apps/backend/src/core/commands-environment-cleanup.test.ts`
- **Base commit:** `148e9ad0aac93b0f363af93e33543b73be36ee40`
- **Original command:** `mise run test` (review preparation, reviewed head `3e2304f810a1494c75e50ef79f4c29bd1efd2cb3`).
- **Worker configuration:** aggregate backend workspace runner with parallel isolated workers; the captured package does not record an explicit worker override.
- **Failure:** line 662 expected `settled=false` after releasing the leader and waiting 30 ms; received true, 382.18 ms.
- **Suite counts:** captured backend 16,830 passed, 150 skipped, 1 failed. Inspected web/backend/root totals: 34,255 passed, 171 skipped, 5 failed; the other failures were repository guards and ownership, plus two between-test missing-plan-directory errors.
- **Original evidence:** `.orkestrator/review-artifacts/review-validation-dac2fcb8-1468-4984-be1b-a5aa978203a7/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name cleanup-recorded-failure -- bun --cwd=apps/backend test ./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures` passed the unchanged complete owner, exit 0, 14.0 s.

## Resolution (2026-11-07)

- **Root cause:** the real 300 ms stage deadline could kill the fixture shell before it forked its sleep descendant. Releasing the held leader then legitimately completed cleanup; the test assumed a descendant existed without awaiting readiness.
- **Fix:** capture the real stage deadline and fire it only after the fixture publishes its PID file (written after forking). Await an observed process-group liveness check after releasing the leader instead of sleeping before a negative assertion. Preserve the blocked retry, group release, stopped-child, durable ledger and successful retry assertions. The narrow spawn spy also accepts Bun's object-form spawn used by node:child_process.
- **Reproduced:** yes — temporarily prepend a shell-builtin loop of 200,000 iterations before the descendant fork. The original test failed at the exact recorded `settled=false` assertion; the repaired test passed with the same delay. The temporary loop was removed. Command: `mise run test:logged -- --name cleanup-startup-before-after -- bun --cwd=apps/backend test ./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures --test-name-pattern 'a hung worktree removal is stopped at its deadline'`. Original failure evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Ui31Wy/cleanup-startup-before-after.log.gz`; fixed run passed in 3.3 s.
- **Stress:** `mise run test:logged -- --name cleanup-startup-race-stress -- bun --cwd=apps/backend test ./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures --test-name-pattern 'a hung worktree removal is stopped at its deadline' --rerun-each=10`. Passed 10 of 10 with the final event-based assertion (exit 0, 7.2 s logged).
