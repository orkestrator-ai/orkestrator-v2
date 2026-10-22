# `ACP bridge > settles Cursor's in-process child as finished` (`bridges/acp-bridge/src/index.test.ts`)

- **ID:** 0051
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** bridges group used two workers while workspace, root,
  and protocol-lockfile groups ran concurrently.
- **Failure:** the test exceeded Bun's default 5,000 ms timeout (`5000.79 ms`).
  Bun then killed the spawned bridge (`killed 1 dangling process`), and the
  in-flight `waitFor` fetch failed as an unhandled `ConnectionRefused` against
  `/session/:id`.
- **Suite counts:** bridges group: 2,503 passed, 11 skipped, 1 failed, 1 error
  across 70 files.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/index.test.ts -t "settles Cursor's in-process child"`
  → passed in 0.3 s.
- **Root cause:** `spawnBridge` already waits up to 5 s for health, then this
  case runs two more 5 s `waitFor` polls, all inside Bun's 5 s default test
  budget. Under aggregate spawn contention the health wait consumed the budget
  before the child could settle. `waitFor` also rethrew connection errors
  immediately, so the killed child became a second unhandled error.
- **Fix:** retry `ConnectionRefused` inside `waitFor` until the deadline so a
  refused connection becomes a bounded wait diagnostic that names the retried
  code, and raise the per-test budget to 20 s. The budget is set once for the
  whole file with `jest.setTimeout`, not on the two tests that happened to fail
  first: the root cause is structural — 138 of the file's `spawnBridge` calls
  are followed by at least one further `waitFor` — so a per-test timeout would
  only have moved the flake to the next case to lose the race. `waitFor`'s own
  default stays at 5 s, deliberately below the test budget, so its diagnostic
  wins against Bun's generic timeout instead of being pre-empted by it.
- **Verification:** focused settle tests passed in 0.3 s, the owning file passed
  in 29.2 s, and the complete concurrent suite passed in 138.5 s with no
  failures. The `waitFor` retry policy itself now has direct unit coverage in
  the same file (`describe("waitFor")`), including the timeout diagnostic.
