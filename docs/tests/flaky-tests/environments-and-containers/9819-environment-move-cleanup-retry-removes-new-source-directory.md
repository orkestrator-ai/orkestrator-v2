# A move cleanup retry removes a new directory at the source pathname under CI load

- **ID:** 9819
- **Status:** open
- **Date observed:** 2026-11-26
- **Test:** `cleanup retries preserve a new directory at the source pathname`
- **File:** `apps/backend/src/core/environments/move.recovery.test.ts`
- **Host:** GitHub Actions `ubuntu-latest`, job `Tests (backend)` of CI run
  45725309461, Bun 1.4.4.
- **Observing head:** `8950e12e2` (`main`, a push).
- **Observing branch base:** `8950e12e2` (a push to `main`).

## Observation

The backend shard ran `mise run test:full` (`bun scripts/test-all.ts`; the
backend group's `test:workspace` with 2 worker slots). The group finished with
24047 pass, 385 skip and 3 fail; the other two failures were the deterministic
`delete-tickets.test.ts` and `writer-guards.test.ts` breakages, which failed
again alone and are fixed on `repair-failing-tests-f6ca1b640dea-r1`. This case
failed in 243.20 ms at line 259, reading the sentinel the test wrote into a
new directory at the moved environment's old pathname:

```
ENOENT: no such file or directory, open '…/ork-env-move-3103-xt8izL/trees/app-20261126-000947-48df247d01c5/sentinel'
```

So `recoverInterruptedEnvironmentMoves` (or something else) removed the new
directory, which the test created after the move had already cleaned its
copied-from source.

The runner's automatic rerun of the owning file alone passed (5.9 s, "PASSED
ALONE … likely a load flake"). Locally on 2026-11-26 (beelink2, Linux)
`bun test src/core/environments/move.recovery.test.ts` from `apps/backend`
passed: 23 pass, 0 fail.

## Assessment

The cause is unconfirmed. `removeOldWorktree` (`move.ts`) keeps a directory at
the source pathname that is not the original by comparing its `dev` and `ino`
with the `sourceIdentity` recorded before the copy. If the file system hands
the new directory the inode number the deleted original had freed, the
identity check passes and recovery deletes the new directory, which is the
failure seen. ext4 (the runner's `/tmp`) can reuse a freed inode number at
once; tmpfs and btrfs on this host did not reuse it in 50 of 50
remove-and-recreate trials, which would explain why the failure has not been
seen locally. This is a hypothesis from reading the code, not a reproduction.

## Next step

Reproduce on an ext4 directory: run the file with `--rerun-each` and
`TMPDIR` on ext4, logging the source's recorded `ino` and the new directory's
`ino` before recovery. If they match when the test fails, the identity check
needs something an inode-number reuse cannot repeat (for example the
directory's birth time, or a marker file written into the source when the
move starts), and this becomes a product fix rather than a test flake.
