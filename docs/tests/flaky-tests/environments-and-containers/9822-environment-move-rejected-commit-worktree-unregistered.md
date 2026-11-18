# A rejected move commit leaves the restored worktree unregistered under CI load

- **ID:** 9822
- **Status:** open
- **Date observed:** 2026-11-18
- **Test:** `rejected path commit clears the journal and preserves subsequent edits (false)`
- **File:** `apps/backend/src/core/environment-move.recovery.test.ts`
- **Host:** GitHub Actions `ubuntu-latest`, job `Tests (backend)` of CI run
  44337206799, Bun 1.4.4.
- **Observing head:** `a671716be` (`main`, #2427).
- **Observing branch base:** `a671716be` (a push to `main`).

## Observation

The backend shard ran `mise run test:full` (`bun scripts/test-all.ts`; the
backend group's `test:workspace` with 2 worker slots). The group finished with
22541 pass and 5 fail; the other four failures were deterministic and failed
again alone. This case failed in 188 ms at line 209:

```
expect(await registeredWorktrees(projectPath)).toContain(environment.worktreePath!);
Expected to contain: "…/ork-env-move-2872-Y4XaTl/trees/app-20261118-154222-504eba7f22f2"
Received: [ "…/ork-env-move-2872-Y4XaTl/app" ]
```

Just before it the diff-stats watcher logged `scan.watcher-failed` with
`ENOENT … watch '…/app/.git/worktrees/app-20261118-154222-504eba7f22f2'`: the
worktree's Git admin directory was missing when the watcher armed.

The runner's automatic rerun of the owning file alone passed (5.7 s, "PASSED
ALONE … likely a load flake"). Locally on 2026-11-18 (arktech-mini, macOS
arm64) `bun test src/core/environment-move.recovery.test.ts` from
`apps/backend` passed: 23 pass, 0 fail. The same test passed in every other
`main` run on 2026-11-18 (runs 44311961894, 44330445220, 44340094394,
44347375426, 44363313590).

## Assessment

The cause is open. The first assertion after rejection found the journal
clear, and the edit at the original path survived recovery. The watcher
reported a missing Git admin directory, and the final worktree listing omitted
the restored path. The rollback path awaits the Git move or rename repair
before rejecting and retains the journal if rollback fails. The observations
leave open when registration went missing and whether concurrent work removed
the admin directory.

## Next step

Reproduce under load (the backend group at its CI worker count, or the file
with `--rerun-each`). Record the rollback Git command's exit result, and
capture `git worktree list --porcelain` and whether `.git/worktrees/<name>`
exists immediately before and after rollback, when the caller receives the
rejection, and after recovery. These observations can show whether rollback
restored registration and, if it did, when it went missing again.
