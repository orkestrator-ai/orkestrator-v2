# Copy-plan deadline test sees both children close before its deadline

- **ID:** 9979
- **Status:** resolved (2026-11-11)
- **Date observed:** 2026-11-11
- **Test:** `copy plan > the deadline fails the step even when neither child can be seen to close`
- **File:** `apps/backend/tests/container-replacement.test.ts:89`

## Observation (2026-11-11)

- **Runs:** branch `remove-opencode-v1-ff22e7ad1c79-r1`, base `5f4e27b1c`
  (merge base with `main`), macOS host.
  - Multi Review validation of commit `5a0b47a88` through `mise run
    test:full` (the backend group's `test:workspace`, `--parallel=2`):
    failed after 104.54 ms.
  - The owning file alone, `mise run test:logged -- --name
    container-replacement.test -- bun test --cwd apps/backend --preload
    ../../tests/setup-node.ts ./tests/container-replacement.test.ts
    --parallel=1`: failed once (106.72 ms) with the same diff.
  - The test alone, `bun test --cwd apps/backend --preload
    ../../tests/setup-node.ts ./tests/container-replacement.test.ts -t "the
    deadline fails the step"`: passed three times in three runs.
  - The implementation-stage run of `apps/backend/tests` (`--parallel=4`)
    on the same branch also failed it once; it passed when rerun alone.
  - After the review fixes (commit `97684d00e`), `mise run test:full` failed
    it again (103.04 ms), and the aggregate runner's single rerun of the file
    alone failed too. The file alone then passed in five of six runs on the
    same host: `bun test --cwd apps/backend --preload
    ../../tests/setup-node.ts ./tests/container-replacement.test.ts` twice
    (32 pass), with `--parallel=1` once of twice (the other: 31 pass, 1 fail,
    this test, 105.49 ms), and through `mise run test:logged` twice (PASS,
    about 17.5 s). Every subset of the `copy plan` tests that includes it
    passed.
- **Failure:** `expect(result).toEqual({ absent: false, output: "",
  producerFailed: true, daemonUnavailable: false })` received the same object
  with `refused: false` added.

## Hypothesis

The extra key means `pipeContainerPath` settled through `finish()` (both
children reported `close`, which returns the `refused` field) rather than
through the deadline's settle timer (which omits it). The fake Docker script
(`sleep 8 &` then `exec sleep 8`) relies on the backgrounded `sleep` keeping
the pipes open after `SIGKILL`, so `close` never fires. On a loaded macOS host
both closes were seen within the 100 ms settle grace, so the step still failed
at the deadline, but by the other path. The behaviour under test (the step
fails within the deadline) held: the duration assertion did not fail.

Not reproduced deterministically. The code under test
(`apps/backend/src/core/container-replacement.ts`, `pipeContainerPath`) is
not changed by the observing branch; that branch only changed the OpenCode
`select` list of `replacementCopyPlan` and its expectation in the same test
file.

## Root cause and fix (2026-11-11)

**Root cause (confirmed).** The test's premise depended on timing. Its
100 ms deadline starts when `pipeContainerPath` spawns the two fake `docker`
children. On a loaded macOS host the deadline's `SIGKILL` sometimes reached
both shells before either had forked the backgrounded `sleep` that holds
the pipes. With no descendant left, both children closed at once, and the step
failed through `finish()` (which adds `refused: false`) rather than through the
deadline's settle timer. The code under test behaved correctly either way: the
step failed within the deadline. A user on a slow machine gets the same correct
failure, so this is not a product race.

**Evidence.** A throwaway probe used the same script, logging the shell's pid
after `sleep 8 &`. It ran 25 times under six busy loops on this host. The close
path occurred in exactly the 2 runs where neither shell had logged (0 of 2
markers), and never when both had. The unchanged test (commit `3c77793e4`)
failed 1 of 25 runs under the same load (`bun test --cwd apps/backend --preload
../../tests/setup-node.ts ./tests/container-replacement.test.ts -t "the deadline
fails the step" --rerun-each 25`).

**Fix.** In `apps/backend/tests/container-replacement.test.ts`, each fake
`docker` now logs its pid once its holder exists. The test asserts both did,
so a broken premise is reported as such. Its deadline is 1.5 s instead of
100 ms, which gives the fork a wide margin: nothing can be awaited for the
fork, because the timer starts at spawn. The duration bound rises from 4 s
to 6 s to match. `pipeContainerPath` is unchanged. The result assertion is
unchanged too.

**Verification.** Under the same six-loop load the fixed test passed 15 of 15,
then 40 of 40 (`--rerun-each`). The owning file passed alone through `mise
run test:logged -- --name container-replacement.test -- bun test --cwd
apps/backend --preload ../../tests/setup-node.ts
./tests/container-replacement.test.ts --parallel=1`.
