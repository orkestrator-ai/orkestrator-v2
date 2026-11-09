# Worktree watcher: a directory removed and created again is still noticed

- **ID:** 6381
- **Status:** resolved
- **Date observed:** 2026-11-05 (recorded from the to-do 2922 investigation)
- **Test:** `worktree watcher on this platform's real watch > a directory removed and created again is still noticed`
- **File:** `apps/backend/tests/worktree-watcher-real.test.ts:346`

The read-only investigation at `4f7ca8231` behind to-do 2922 reported this case as
intermittent. It kept no failure message, command or duration, so none is
recorded here.

Not reproduced so far. On beelink on 2026-11-05 at `41f9eb638` it passed 8 of 8
runs alone, each in 1 to 2 s, at a load average of 40 to 42:

```sh
mise run test:logged -- --name watcher -- bun --cwd=apps/backend test tests/worktree-watcher-real.test.ts -t "a directory removed and created again is still noticed" --parallel=1 --only-failures
```

It also does not appear in the failed-step logs of the six `main` CI runs checked
that day (42095487181, 42095512494, 42095657507, 42095680675, 42095902842,
42096069100). A recurrence should add its message, command, worker configuration
and duration here. No assertion, timeout or retry was changed.

## CI recurrences (2026-11-09)

`mise run flaky:recurrence -- 6381 --base 448e9fffb` answered "open". Observed
from branch `fix-ci-main-5daa3930bd92`, base `448e9fffb`.

- CI `main` run 42548026171 (`407252cf1`, #1995), job "Tests (backend)"
  128937176173, the backend shard of the complete non-iOS suite
  (`ORKESTRATOR_BACKEND_TEST_WORKERS` default, Ubuntu 26.04, four cores):
  `error: no change noticed in src` at `worktree-watcher-real.test.ts:117`,
  reached from the second `expectNoticed` at line 362, after 90,485.89 ms.
- CI `main` run 42604409601 (`448e9fffb`, #2002), job "Tests (backend)"
  129116565174, same configuration: the same error and line after
  90,538.13 ms.

Both failed the second wait, after `src` was removed and created again; the
first wait, before the removal, passed.

## Resolution (2026-11-09)

- **Root cause:** a product bug in the Linux (per-directory) strategy of
  `apps/backend/src/core/worktree-watcher.ts`. A watch was replaced only when
  the directory's identity, `dev:ino` from `worktreeWatchPlanIo.directoryIdentity`,
  changed. Linux ext4 hands a removed directory's inode number to the next
  directory made, so after `rm -r src && mkdir src` the identity usually reads
  the same, the watcher kept the old recursive watch, and that watch is dead:
  inotify dropped it with the old directory (Bun reports `rename` with no
  filename, then nothing). Nothing in the recreated directory was ever
  reported. It passed whenever another allocation took the freed number first,
  or a plan pass read the identity while `src` was absent, which is why it was
  intermittent on CI and passed on beelink.
- **Fix:** a `rename` from a direct watch that names a watched directory now
  closes that watch and every watch below it (`retireWatchesWithin`), and the
  next plan pass watches whatever is there. Identity is still read for names
  that have no watch. Two cases in `worktree-watcher-split.test.ts` cover a
  replacement with an unchanged identity, for the directory and for the
  watches below it; both failed before the fix. The existing "replaced under
  the same name" case now waits for the new watch, because the old one now
  closes at the event rather than in the plan pass.
- **Reproduced:** yes. In a Linux container (`orkestrator-v2` dev image, Bun
  1.4.4), `rm -r` followed by `mkdir` of the same directory reused the inode
  number 20 of 20 times, and a recursive `fs.watch` on the old directory
  reported nothing for a write into the new one. Running this case there
  (worktree bind-mounted, `output/watch-fixtures` on a fresh ext4 Docker
  volume): `bun test --preload ../../tests/setup-node.ts tests/worktree-watcher-real.test.ts -t "a directory removed and created again"`
  failed without the fix with `no change noticed in src` after 90,434.97 ms,
  the CI signature, and passed with it in 776.80 ms.
- **Stress:** the complete `tests/worktree-watcher-real.test.ts` plus
  `src/core/worktree-watcher-split.test.ts` passed 3 of 3 runs in the same
  Linux container (59 pass each). On macOS the four watcher files
  (`worktree-watcher-split`, `worktree-watch-plan`, `worktree-watcher`,
  `worktree-watcher-real`) passed with `--parallel=4` (103 pass).
