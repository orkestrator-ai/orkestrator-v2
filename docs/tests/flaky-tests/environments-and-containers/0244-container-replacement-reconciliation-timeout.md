# Container replacement reconciliation aggregate timeout

- **ID:** 0244
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `restart reconciliation > a kill at any phase before the commit write leaves the original authoritative`
- **Owning file:** `apps/backend/tests/container-replacement.test.ts`
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name full-tests-host-tools -- mise run test`
- **Worker configuration:** four workspace slots (two package tasks with two Bun workers each), one root worker, two bridge slots, and one protocol slot under the aggregate host-capacity runner.
- **Failure:** five-second outer timeout at 5004.19 ms, followed by an unhandled between-tests assertion at line 385: expected reconciliation result `settled`, received `unreachable`.
- **Suite counts:** backend: 8,063 tests, 8,023 passed, 39 skipped, 1 failed and 1 additional error across 436 files in 418.88 seconds. The aggregate also reported three unrelated firewall fixture timeouts in the root group.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.4v9Bnb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and adjacent `summary.json`.
- **Isolated rerun:** the same GNU-tool PATH prefix with `mise run test:logged -- --name container-replacement-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-replacement.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 5.7 seconds.
- **Hypothesis:** the subprocess-based reconciliation fixture exhausted its outer deadline during aggregate execution. The unchanged owning file passed in isolation; host contention may contribute, but the root cause remains unconfirmed. The change being validated adds account-refresh tests and does not alter container replacement, its fixtures, or their deadlines.
- **Recurrence (2026-10-24, node mbp3, load average 19 to 31):** the todo-0050 branch's `env -u PORT mise run test:logged -- --name full-test -- mise run test` failed it again, at 5006.28 ms. This time the owning file also failed when rerun alone (`bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/container-replacement.test.ts`: 22 passed, 1 failed, `unreachable` instead of `settled`). So did the same file on a worktree of `main` at `71227437`, run straight afterwards under the same load. With `--timeout 30000` the case passed on both trees in about 3 s. This is the first evidence that host contention alone reproduces it, with no change involved: the fake-docker fixture's calls take long enough under load for reconciliation to answer `unreachable`. The branch touches neither container replacement nor its fixtures.

- **Recurrence 2026-10-24** (0043 known-limitations branch, node mbp3, `mise run test` via `test:logged`): timed out at 5,001 ms in the workspace group; `bun test --cwd apps/backend ./tests/container-replacement.test.ts --parallel=1` then passed (11.8 s).

- **Recurrence 2026-10-24 (node mbp3, Control MCP voice branch `todo-0041-control-mcp-voice-4a2c0ccc548b`):** failed in both `mise run test` aggregates (artifacts `orkestrator-test-run.SqxFKk` and `orkestrator-test-run.NcXAI6` under `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/`); the unchanged owner failed alone once at the same 5 s budget, then passed alone (23 pass, 0 fail). The branch does not touch this area.

## Recurrence during 0016 validation (2026-10-24)

- **Failure:** the same case failed in the aggregate at 5,000.71 ms (five-second deadline).
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`
  on branch `todo-0016-slash-command-catalogue` (0016 legacy catalogue
  retirement), node mbp3, while a `dev:test` profile and live browser runs
  shared the host.
- **Suite counts:** backend 10,530 passed, 115 skipped, 17 failed across 618
  files (672.7 s). 14 of the 17 are the deterministic OpenCode conformance
  version check (`conformance-execution-policy.test.ts` expects `1.19.0`, the
  pin and host binary are `1.19.4`; fails alone too, unchanged from `main`).
  Root, bridges and protocol groups passed.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.IY8RjI/full-test.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts tests/container-replacement.test.ts` from `apps/backend`: 23 passed, 0 failed.
- **Disposition:** recurrence confirmed by the isolated pass. No assertion,
  deadline or skip was changed.

- **Recurrence (2026-10-27, node mbp3):** the todo-0214 branch's complete `mise run test` failed it at 5001.48 ms. Rerun alone (`bun test ./tests/container-replacement.test.ts --parallel=1` from `apps/backend`), the unchanged owner passed (29 of 29). The branch does not touch container replacement. See [1150](../aggregate-validation-runs/1150-storage-files-size-0214-validation.md).

## Direct-history cursor review validation — 2026-10-27

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 worker slots. Other worktrees were validating on the shared host.
- **Failure:** `restart reconciliation > a kill at any phase before the commit write leaves the original authoritative` exceeded the five-second budget (5,023.10 ms), followed by the between-test assertion at line 599: expected `settled`, received `unreachable`.
- **Isolated rerun:** `mise run test:logged -- --name container-owner -- bun test --cwd apps/backend ./tests/container-replacement.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 31.0 s).
- **Evidence:** `orkestrator-test-run.wESThp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion. Aggregate results and other owner reruns are recorded in [1140](../aggregate-validation-runs/1140-direct-history-cursors-0232-validation.md).
- **Assessment:** credible recurrence of the existing timing flake. Host contention remains plausible but unproven; no implementation, assertion, deadline or skip changed.

## Resolution (2026-11-15)

- **Root cause:** The phase loop reconciles seven fake-Docker operations in one test; at load about 30 it exceeded Bun's 5 s default alone too.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** yes (earlier evidence in this case, 2026-10-24) — at load about 30 the owner failed alone at 5 s and passed with `--timeout 30000` in about 3 s; that is the condition the 60 s default now removes. Not re-run against the unchanged code here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
