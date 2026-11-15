# Local fork from the source commit exceeds the test deadline under load

- **ID:** 1105
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `fork_environment > starts a local fork from the source commit rather than origin/main`
- **Owning file:** `apps/backend/tests/commands-environment-fork.test.ts:302`
- **Tested revision:** `5eb3f9037` on branch `test-temp-directory-4cd0548cf2b5-r1` (from `main` at `ce205ad34`). The branch changes test teardown and temporary-directory handling; it does not touch environment forking or this file.
- **Original command:** the 0247 qualification sweep, `TMPDIR=<empty private dir> mise exec -- bun run --cwd apps/backend test:workspace` (two workers), run directly rather than through Turbo, on macOS 27.0 arm64 while other worktrees' suites loaded the host (load average up to 37 during the session).
- **Failure:** `this test timed out after 5000ms`, reported at 10030.64 ms, after `killed 2 dangling processes`.
- **Suite counts:** backend 11,992 passed, 115 skipped, 13 failed across 12,120 tests in 719 files (557.10 s). The other twelve were Git-heavy deadlines in `environment-move.test.ts` and `worktree-snapshots-git.test.ts` (see [1106](1106-environment-move-git-fixtures-under-host-load.md), [9892](9892-worktree-git-aggregate-timeouts.md) and [0957](0957-worktree-index-and-shared-ref-aggregate-timeouts.md)).
- **Unchanged rerun:** `mise run test:logged -- --name rerun-commands-environment-fork -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-environment-fork.test.ts` passed the complete owner in 5.4 s.
- **Evidence:** the sweep's own log, `backend.log` under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/ork0247-qual/logs/` (outside the logged runner, so not compressed).
- **Hypothesis:** host contention delayed the fork's Git subprocesses past Bun's generic five-second deadline, like the environment-move family; not established.
- **Changes:** evidence only; the test, its timeout and skips were not changed.

## Main-merge validation recurrence (2026-10-27)

The merge of `863b578217fca437c37c53372bec7a4f97719079` into
`711de8869705b8672a214aeb4d82c408a055c2d0` was validated with
`mise run test:logged -- --name merge-repository-tests -- mise run test`,
using two backend workers and the concurrent workspace/root/bridge/protocol
groups. Backend totals were 12,072 passed, 120 skipped, 18 failed and six
between-test errors across 733 files. The aggregate remains failed; see
[1013](../aggregate-validation-runs/1013-interactive-command-main-merge-validation.md)
for all groups and owning-file results. Evidence:
`orkestrator-test-run.2onpQ5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory.

The same local-fork case exceeded its five-second deadline (26779.98 ms reported). The complete unchanged owner passed, exit 0 in 3.5 s, with `mise run test:logged -- --name merge-environment-fork-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-environment-fork.test.ts --parallel=1 --only-failures`. This is another aggregate-only recurrence; cause remains unconfirmed. No assertion, timeout, skip or implementation changed.


## Permission-rules main-merge recurrence (2026-10-27)

While merging `f7edf57f1bcd6ed52b6b2fb68d4864065198ced7` into
`19b8716087e786bc49512b65aa356c8f85f05b43`, the final
`mise run test:logged -- --name merge-final-default-tests -- mise run test`
run (two backend workers, concurrent workspace/root/bridge/protocol groups)
reported `fork_environment > starts a local fork from the source commit rather than origin/main` at 5956.85 ms.
The complete owning file then passed alone, exit 0 in 8.1 s:

```sh
mise run test:logged -- --name merge-fork -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-environment-fork.test.ts --parallel=1 --only-failures
```

Aggregate evidence is in
`orkestrator-test-run.QXGTmp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. The aggregate remains non-green; the
passing runner deletes its log. Host contention remains an unconfirmed
hypothesis. No assertion, timeout, skip, or implementation was changed for
this recurrence.

The backend aggregate finished with 12,572 passed, 123 skipped, and 21 failed
across 769 files (630.64 s). Full merge validation and remaining failures are
recorded in [1171](../aggregate-validation-runs/1171-orkestrator-permission-rules-0723-validation.md).

## Resolution (2026-11-15)

- **Root cause:** The fork case runs real Git; it exceeded Bun's 5 s default in loaded sweeps.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The file's own `setDefaultTimeout(30_000)`, which undercut the preload, now sets `DEFAULT_TEST_TIMEOUT_MS` (60 s) explicitly, because in a run without `--parallel`/`--isolate` Bun applies a preload's `setDefaultTimeout` to the first test file only.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
