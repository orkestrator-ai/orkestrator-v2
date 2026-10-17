# Claude command-changes `beforeAll` git fixture hangs — Bun 1.4.2 spawnSync spin

- **ID:** 0269
- **Test:** `(unnamed)` — the file-level `beforeAll` that builds the git fixture
  repository in `bridges/claude-bridge/src/services/command-changes.test.ts`
- **Status:** resolved
- **Date observed:** 2026-10-01 to 2026-10-13 (11 GitHub Actions runs, 6 on
  `main`): 36872502779, 37458179691, 37496472827, 37502249585, 37770718527,
  38071496783, 38248303351, 38266721050, 38324803659, 38402759548,
  38402884080.
- **Original command:** job "Unit and integration tests", bridges group,
  `@orkestrator/claude-bridge:test:bridge`:
  `bun test src --preload ../../tests/setup-node.ts --only-failures --timings=… --update-timings --parallel=${ORKESTRATOR_TEST_WORKERS:-1}`.
- **Worker configuration:** `bun test v1.4.2 (744846f84) 1x PARALLEL` in every
  failing run. `--parallel` implies `--isolate`, so the file ran after other
  files in the same worker process.
- **Failure:** `(fail) (unnamed) [5000.08ms]`–`[5005.92ms]`, followed by
  `^ a beforeEach/afterEach hook timed out for this test.` Where the error was
  printed, it was `error: Command failed: git …` from `execFileSync` in the
  `beforeAll`. The command that was killed varied: `git config user.name Bridge`
  in 6 runs, `git commit -qm init` in 2, `git add -A` in 1, and no command was
  printed in 2.
- **Suite counts:** e.g. run 38402884080: claude-bridge 1,231 tests across 48
  files, 1,225 passed, 1 failed (35.12 s).
- **Isolated rerun:** `bun test src/services/command-changes.test.ts --preload ../../tests/setup-node.ts`
  (from `bridges/claude-bridge`, Bun 1.4.3) → 8 pass in 0.6 s. Timing the hook
  showed the five git calls take 65 ms in total (init 14 ms, each config about
  9 ms, add 10 ms, commit 22 ms). Twelve full claude-bridge suites on Bun 1.4.2
  (`--parallel=1`) did not reproduce it: 1 on macOS, 2 on macOS with
  `BUN_GARBAGE_COLLECTOR_LEVEL=2 --smol`, and 9 in `oven/bun:1.4.2-debian`
  limited to 4 CPUs. A synthetic two-file `spawnSync` reproducer did not
  trigger it either.
- **Hypothesis / evidence:** the hook does no waiting of its own. It is five
  synchronous `execFileSync("git", …)` calls, and nothing in the file or harness
  spawns anything at import (the `node:child_process` mocks recorded no calls
  before `beforeAll`). A `beforeAll` that normally takes about 65 ms reaching
  5 s means one `execFileSync` never returned. When the hook timeout fired,
  Bun killed the child, which is why the failing git command varies. The Bun
  1.4.3 release notes
  ([bun.com/blog/bun-v1.4.3](https://bun.com/blog/bun-v1.4.3), Bugfixes > Bun
  APIs) list this fix: on macOS and Linux, `spawnSync` or `execFileSync` could
  spin at 100% CPU and never return after a garbage collection. The trigger was
  an earlier `Bun.spawnSync` call that had released a stream, such as a previous
  test file's `process.stderr`, and users hit it in large `bun test --isolate`
  suites. That matches this file: a synchronous spawn in a `--parallel`
  (isolating) worker, after other files in the same process.
- **Root cause:** the Bun 1.4.2 runtime bug described above. The test fixture
  was not slow.
- **Fix:** 478e515bf (#964, 2026-10-13 22:45 +0100) pinned Bun 1.4.3 in
  `mise.toml` and `packageManager`, and CI installs it through
  `jdx/mise-action`. The later edits to this file, da0b40cea (#993) and
  fc0b783fe (#1002), changed only the expected `PreToolUse` hook count. The
  `beforeAll` is unchanged, so neither edit fixed this. #999 (cefcaf691) changed
  CI streaming and the watchdog, not this file.
  This investigation also corrected a separate rerun bug in the same file. The
  persistence test cleaned up with `commandChangeJournal(id).remove()`, which
  left a removed journal cached in the module's `journals` map. A removed
  journal ignores every later `append`, so under `--rerun-each` every run after
  the first failed (29/30) with `commandChanges` undefined. The cleanup now
  calls `deleteCommandChangeJournal(id)`, which also evicts the cached
  instance. This was not the CI flake, because CI runs each file once.
- **Verification:**
  - CI history, from the logs of every failed "Lint and format" run
    (`gh run view --log-failed`): on Bun 1.4.2 (2026-10-01 to 2026-10-13
    13:50), the hook failed in 11 of the 21 failed runs that showed
    claude-bridge output. On Bun 1.4.3 (2026-10-13 22:50 to 2026-10-16 23:54),
    it failed in 0 of the 18 failed runs that showed claude-bridge output.
    Those runs all print `bun test v1.4.3 (c6da4a4d3)`. All 49 successful runs
    since 2026-10-13 also passed the unit job, so there were no failures in 67
    runs on 1.4.3.
  - Local, Bun 1.4.3: `--rerun-each 30` → 240 pass, 0 fail (was 211/29 before
    the cleanup fix). With all 18 cores saturated by `yes`, it also gave 240
    pass, 0 fail.
  - Full package suite: `bun run test:bridge` → 1,463 pass, 0 fail (68 files).
  - `bunx oxfmt --check`, `bunx oxlint`, and `tsc --noEmit` for claude-bridge
    are clean.
