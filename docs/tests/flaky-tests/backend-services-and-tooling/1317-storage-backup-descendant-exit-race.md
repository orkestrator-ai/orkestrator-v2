# Storage backup descendants remain visible after abrupt backend death

- **ID:** 1317
- **Status:** resolved
- **Date observed:** 2026-10-30
- **Test:** `database snapshots > abrupt backend death terminates the supervisor and its blocked copy before restart cleanup`
- **File:** `apps/backend/src/core/storage-backups.test.ts:401`
- **Original command:** `mise run test` during pipeline validation-history review preparation.
- **Failure:** `descendants.some(alive)` was true instead of false after the bounded exit wait (2484.04 ms). Backend totals were 11,266 passed, 87 skipped and two failed across 775 files (437.48 s).
- **Preparation evidence:** `.orkestrator/review-artifacts/review-validation-273917ca-9984-4108-8435-62e870238e79/validation-04.stdout.txt`.

The complete unchanged owner passed alone with exit 0 in 3.0 s:

```sh
mise run test:logged -- --name recorded-backend-backups -- bun test --cwd apps/backend ./src/core/storage-backups.test.ts --parallel=1 --only-failures
```

The logged runner removed passing output and retained its summary in
`orkestrator-test-run.qgBIcT` below the host temporary directory. Delayed
descendant exit or observation under shared-host load is a hypothesis, not a
confirmed cause. No storage implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** not established. The test bounded both the start-up discovery (100 × 20 ms) and the post-kill exit wait (100 × 20 ms ≈ 2 s) by wall time, and `alive` used signal 0, which also succeeds for an unreaped zombie. Either a slow reap on a loaded host or a zombie awaiting its adopter fits `descendants.some(alive)` being true at 2,484 ms.
- **Fix:** `apps/backend/src/core/storage-backups.test.ts`: discovery waits until both descendants appear or the parent exits; after the SIGKILL it waits for them to be gone with no deadline (the 60 s default from `tests/default-test-timeout.ts` is the hang watchdog); `alive` treats a `Z` state as exited. Two sibling cases lose their elapsed-time bounds (`< 4_000`, `< 5_000`) in favour of awaiting settlement; the background holder in `settles at exit while a background child holds the output` is killed in `finally`.
- **Reproduced:** no; the starvation was not provoked against the unchanged file.
- **Stress:** `mise run test:logged -- --name f4-backend-cont2 -- bun scripts/test-under-contention.ts --burners 6 -- bun --cwd=apps/backend test src/core/storage-backups.test.ts src/core/user-commands.test.ts src/core/graph-project-templates.test.ts --preload ../../tests/setup-node.ts --parallel=1` passed (174.4 s). Base `a8b89f154`.
