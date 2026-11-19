# CLI lost-submission lookup misses the shared deadline under load

- **ID:** 9880
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `waiting through a lost submission response > submission and an absent-key lookup share one deadline`
- **File:** `packages/cli/tests/client-waits.test.ts:351`
- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`, default 4/1/2/1 workspace/root/bridge/protocol reservations; CLI used two isolated Bun workers while browser validation ran concurrently.
- **Failure:** the 300 ms shared deadline yielded zero lookups instead of one (321.23 ms observed).
- **Suite counts:** CLI reported 178 passed, one failed across 179 tests in 14 files (34.93 s).
- **Owning-file rerun:** `mise run test:logged -- --name cli-waits-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 7.4 s).
- **Evidence:** `orkestrator-test-run.92oAQN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion; outer run `orkestrator-test-run.6yesvR`.
- **Hypothesis:** concurrent load consumes the remainder of the short deadline after the delayed submission; unconfirmed. No CLI implementation, assertion, timeout or skip changed.

The final-source retry, `mise run test:logged -- --name final-complete-tests -- mise run test`, passed every non-iOS group (exit 0, 454.4 seconds). Root/support passed in 141.5 seconds.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The shared-deadline case failed after 333.11 ms. `mise run test:logged -- --name merge-owner-cli-waits -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (7.5 s).

Full failure names, counts, evidence paths and unresolved limitations are in [9884](../aggregate-validation-runs/9884-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Design resume identity review — 2026-10-25

- **Original command:** `mise run test:logged -- --name resume-repository -- mise run test`; workspace reservation four slots, CLI two isolated Bun workers, with other checkouts sharing the host.
- **Failure:** the shared 300 ms deadline yielded zero lookups instead of one (315.04 ms). CLI: 255 passed, one failed across 256 tests in 23 files (35.57 s).
- **Complete unchanged owner:** `mise run test:logged -- --name resume-cli-waits-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures` passed (exit 0, 7.8 s).
- **Evidence:** `orkestrator-test-run.gciHk4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; compressed from partial inner logs after the outer watchdog stopped the run. Outer run: `orkestrator-test-run.aqhArP/`.
- **Assessment:** confirmed recurrence; no CLI code, assertion, deadline or skip changed. The original aggregate remains failed.

- **Final aggregate result for this recurrence:** incomplete after the outer 30-minute watchdog stopped the remaining backend run, with observed failures preserved.

## Resolution (2026-11-15)

- **Root cause:** the test measured real wall time: a 180 ms delayed submission inside a 300 ms `--timeout`, then asserted exactly one lookup and an elapsed bound. On a starved host the submission alone used the whole budget, so no lookup ran. `submitForWait` (`packages/cli/src/client/commands/common.ts`) also read `Date.now()` directly, so a test could not put the shared deadline on a controlled clock even though `observe` already accepted one.
- **Fix:** `submitForWait` takes its clock from `observationClock(context.io)`: in the executable that is still `Date.now` (its IO has no `sleep`), so production behaviour is unchanged; a test IO that supplies `now`/`sleep` governs the submission, the lookups and the poll delays with one clock. The returned `deadline` is translated back to `Date.now()` for callers. The test (`packages/cli/tests/client-waits.test.ts`) now advances a virtual clock by 4.25 s when the fake gateway receives the submission (`onSubmit`), uses a 10 s `--timeout`, and asserts the exact poll schedule (250, 500, 1000, 2000, 2000 ms) and one lookup per poll. No wall-clock bound remains.
- **Reproduced:** yes. The unchanged test under `bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts <copy of HEAD's test> -t "share one deadline" --rerun-each=10` failed 10 of 10 with zero lookups. The rewritten test passed 10 of 10 under the same command. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f3-fix-new -- bun scripts/test-under-contention.ts --burners 6 -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts -t "share one deadline" --rerun-each=10` passed (10/10). The complete owner passed alone. Sibling cases in the same `describe` (`a stalled lookup is bounded…`, `recovery and final observation share…`) still assert real elapsed bounds; they are not part of this case.


## OpenCode domain review validation — 2026-11-16

- **Branch / base:** `backend-domain-folder-83c01c878209-r1`, reviewed commit
  `afe628c689611933b5b946785ee2a3983e83e59c`, merge base
  `a0920f1a707332319d71e64dd1c8445ccd75f227`.
- **Original command:** `mise run test:logged -- --name slow-tests -- mise run test:slow`;
  workspace/root/bridge reservations 4/1/2, CLI two isolated Bun workers,
  component browser validation running concurrently.
- **Exact test:** `waiting through a lost submission response > recovery and final observation share the remaining deadline`,
  `packages/cli/tests/client-waits.test.ts:412`.
- **Failure:** expected `deadline-exceeded`, received `transport-uncertain`
  after 342.54 ms. CLI slow group: 61 passed, one failed across 62 tests in
  four files (21.18 s). This sibling still uses a real 160 ms submission delay and
  a 300 ms overall timeout; the virtual-clock repair above covered the other
  shared-deadline case, not this one.
- **Owning-file rerun:** `mise run test:logged -- --name address-cli-waits-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 7.2 s).
- **Evidence:** host temporary directory `orkestrator-test-run.FVTiB8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
  (compressed on aggregate completion); outer run `orkestrator-test-run.AEsIYA`.
- **Classification:** reopened for the remaining real-clock sibling. The
  recurrence checker (`mise run flaky:recurrence 9880 --base a0920f1a707332319d71e64dd1c8445ccd75f227`)
  confirms the base contains the earlier fix. This is not evidence that its
  virtual-clock case regressed. No CLI code, assertion, timeout or skip changed;
  contention consuming the recovery budget is a hypothesis, not an established
  product cause.

## Resolution of the real-clock siblings (2026-11-19)

- **Root cause:** the same as the 2026-11-15 repair, in the two siblings it
  did not cover: `recovery and final observation share the remaining deadline`
  (160 ms real submission delay inside a 300 ms `--timeout`, then a 450 ms
  wall-clock bound) and `environment --wait through a lost submission response > exec recovery and final observation share the --timeout deadline`
  (400 ms inside 500 ms, then an 850 ms bound). On a starved host the real
  delay used the whole budget before the recovery lookup answered, so the
  result was `transport-uncertain` instead of `deadline-exceeded`, or the
  elapsed bound failed.
- **Reproduced:** yes. A copy of the unchanged test file under
  `bun scripts/test-under-contention.ts --burners 6 -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts <copy> -t "recovery and final observation" --rerun-each=10`
  (macOS, burners unpinned) failed 3 of 20: two `transport-uncertain` where
  `deadline-exceeded` was expected (both siblings) and one elapsed 553 ms
  against the 450 ms bound. Base `fe9d1f5d6`.
- **Fix:** both siblings now use the virtual clock the 2026-11-15 repair
  introduced: the fake gateway advances it by 4.25 s when it receives the
  submission (`onSubmit`, now also accepted by `lostEnvironmentMutation`),
  the IO's `sleep` advances it, and the `--timeout` is 10 s. Each asserts
  `deadline-exceeded`, exactly one recovery lookup, and that the whole wait
  ended within the original 10 s budget (a fresh budget after recovery would
  run past 14.25 s). No wall-clock bound remains in either case.
- **Verified under the same condition:** the fixed file with the same
  contention command passed 20 of 20, then 40 of 40 with `--rerun-each=20`.
- **Stress:** `mise run test:logged -- --name f-a-cli-waits-owner -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures --rerun-each=3`
  passed (exit 0, 7.6 s). The remaining real-clock siblings (`a stalled lookup is bounded…`,
  `recovered lifecycle bounds a stalled … read`, `ordinary admission retains…`)
  measure real elapsed time on purpose and have no recorded failure; they
  were not changed.
