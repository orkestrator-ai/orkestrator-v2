# CLI scenario retry-and-retention: empty JSON output

- **ID:** 1001
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `packaged client against a real backend > scenario: retry-and-retention`
- **File:** `packages/cli/tests/cli-client.test.ts`
- **Original command:** `mise run test` on branch `todo-0109-rootless-linux-runtime-d03790b22a6c` (omarchy-hp, shared host), CLI package `test:workspace` with two workers.
- **Failure:** `[project add] JSON mode printed 0 lines on stdout` after 2,642 ms.
- **Suite counts:** CLI package 325 pass, 1 fail.
- **Isolated rerun:** `mise run test:logged -- --name a-cli -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts tests/cli-client.test.ts --parallel=1` passed (19.7 s).
- **Hypothesis:** the packaged client's first command against a backend that was still starting under host load; the branch did not change the CLI.

## Triage (2026-11-15)

- **Not changed:** `project add` exited with no stdout after 2.6 s. This is not a deadline: the CLI driver's own limit is 10 min. The cause (a client crash, or a startup refusal printed elsewhere) cannot be established from the record. Still open.

## Recurrence (2026-11-16): scenarios hang until the 120 s timeout

- **Recurrence check:** `mise run flaky:recurrence -- 1001 --base c1fcc573bc079b4d856d53e31c45d5ebf2485d11 --registry-ref origin/main`: open.
- **Observed on CI:** `Tests (workspace)` shard, Linux x64. Run 43771447654 (`steer-opencode-testing-7383f20002c3-r1`): `scenario: read-only`, `scenario: local-lifecycle` and `scenario: retry-and-retention` each timed out after 120,000 ms. Run 43785802510 (`main` at c1fcc573b): `scenario: read-only` timed out after 120,000 ms. In both runs the runner's lone rerun of `packages/cli/tests/cli-client.test.ts` passed (12.9 s and 11.3 s).
- **Reproduced locally (macOS arm64, Bun 1.4.4, host load about 8):** `bun test --cwd packages/cli --preload ../../tests/setup-node.ts tests/cli-client.test.ts --parallel=1`, the owning file *alone*, hung in 4 of 9 runs, each time with one or two tests at 120,000 ms (`retry-and-retention`, `setup-failure`, `local-lifecycle` and `packaged scenario backend receives the sanitized isolated environment`).
- **What hung:** temporary stage tracing in `CliDriver.run` showed every scenario stage before the hang finishing in well under a second. The hung call was a `project add` CLI child, the first `Bun.spawn` after `createFixtureRepository`. `ps` showed that child as a zombie (`Z`): it had exited, but none of its `stdout` text, `stderr` text or `exited` promises ever settled, so `Promise.all` waited until the test timeout. The only other children were the scenarios' own backends.
- **Correlation:** `createFixtureRepository` ran seven `git` commands through `node:child_process` `spawnSync`, and `cases.ts` used `spawnSync` for its own `git` and `pgrep` checks, while concurrent tests (`test.concurrent`) awaited `Bun.spawn` children in the same process. A standalone script mixing `spawnSync` with concurrent `Bun.spawn` children did not reproduce the lost exit outside the test runner, so the mechanism inside Bun is not established.

## Hang variant fix (2026-11-16)

- **Fix:** `packages/cli/scenarios/harness.ts` adds `runCommand` and `runGit`, which use `Bun.spawn` with a 60 s kill deadline. `createFixtureRepository`, the provider toolchain install in `startIsolatedBackend`, and `cases.ts`'s `git` and `pgrep` checks use them, so no scenario helper reachable from `cli-client.test.ts` blocks the event loop in `spawnSync` any more. `docker-decoys.ts` still uses `spawnSync`, but only for opt-in container scenarios.
- **Reproduced:** yes. Before the change, 4 of 9 plain runs of the owning file hung. With only the fixture's `git` converted, 1 of 22 hung (while `cases.ts` still used `spawnSync`). With every helper converted, 15 of 15 plain runs passed.
- **Stress:** `mise run test:logged -- --name cli-client-contention -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts tests/cli-client.test.ts --rerun-each=8 --parallel=1 --only-failures` passed (macOS, unpinned burners).
- **Status stays open:** the original symptom above (`project add` printing no stdout after 2.6 s) is a different failure from a hang, and this change does not show that it shared the cause.

## Recurrence (2026-11-23): a hang, and diagnostics for the next one

- **Recurrence check:** `mise run flaky:recurrence -- 1001 --base a2609f28b --registry-ref origin/main`: open.
- **Observed on CI:** run 45194838352 (pull request #2548, base `a2609f28b`), job 137762423199 `Tests (workspace)`: `scenario: retry-and-retention` timed out after 120,000.38 ms. The runner's lone rerun of `packages/cli/tests/cli-client.test.ts` passed (10.9 s). The output does not say which command hung.
- **Change (2026-11-24):** `CliDriver.run` (`packages/cli/scenarios/harness.ts`) now fails a command that is still unsettled five seconds after its limit, naming the stage, the pid, which of stdout, stderr and exit never settled, and the exit code Bun holds. `cli-client.test.ts` gives its drivers a 60 s limit, below the file's 120 s test timeout. Covered by `packages/cli/tests/scenario-harness.test.ts`. This adds evidence only; a hang still fails the test.
- **Verification:** `cli-client.test.ts` and `scenario-harness.test.ts` passed (12 tests, 7.0 s).
