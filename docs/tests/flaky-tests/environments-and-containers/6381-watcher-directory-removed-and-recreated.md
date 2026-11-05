# Worktree watcher: a directory removed and created again is still noticed

- **ID:** 6381
- **Status:** open
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
