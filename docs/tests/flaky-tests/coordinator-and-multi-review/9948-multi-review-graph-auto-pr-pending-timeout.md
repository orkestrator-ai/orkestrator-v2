# Multi Review graph auto-PR pending case times out under load

- **ID:** 9948
- **Status:** resolved
- **Date observed:** 2026-11-11

Test: `no saved revision of the run reads as an end the bespoke engine never
shows > a clean report under auto-PR is pending its pull request from the save
that holds it` in `apps/backend/src/core/review/graph-surfaces.test.ts`.

Observed on `webkit-scroll-fix-d230c4f38350-r1` at `c20f90936`, base
`498b68766f5c9f357a3a86782406d1e9e0977559`. The branch changes no backend
production code; its only backend edit is
`git-checkout-template-test-support.ts`, which this test's import graph does
not reach (`multi-review-graph-surfaces-test-support.ts`,
`multi-review-graph-test-support.ts`, `graph-run-test-support.ts`). No
existing group index entry matched this test; this is a new observation, not
a counted recurrence.

Original command:
`mise run test:logged -- --name review-default-tests-rerun-2 -- mise run test`
on macOS, with two other worktrees running their own suites (host load
average about 35 to 41). The test hit Bun's 5,000 ms default deadline at
5,002.53 ms, followed by `killed 1 dangling process`. The backend group
counted 18,323 pass and 1 fail across 1,276 files (539.4 s); every other
group passed.

The aggregate runner reran the unchanged owning file alone: 11 pass, 0 fail
in 8.1 s. No cause has been established. The test drives a coordinator world
with real processes, so a deadline miss under heavy host load is plausible,
but that has not been shown. No deadline, assertion or implementation
changed. Evidence: `orkestrator-test-run.ftuyJr` under the host temporary
directory.

## Resolution (2026-11-15)

- **Class:** default test budget (A). `src/core/review/graph-surfaces.test.ts` sets no budget of its own: no `setDefaultTimeout`, no third-argument or hook timeout, and no wall-clock wait deadline in the test or the helpers it uses. Its waits use the harness's controlled clock (`time.jump`).
- **Root cause:** the recorded failure was Bun's former 5 s default per-test/hook budget expiring while the host was loaded; the owner passes alone in a few seconds and nothing it asserts depends on elapsed time.
- **Fix:** none in this file. It now runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets the default per-test and hook budget to 60 s as a hang watchdog.
- **Reproduced:** no. Under contention with the old budget forced (`mise run test:logged -- --name a9948 -- bun scripts/test-under-contention.ts --core <n> --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-graph-surfaces.test.ts --timeout=5000`) the owner passed (27.3 s), so six burners on one core did not recreate the aggregate's load.
- **Stress:** the same contention command with `--rerun-each=3` at the new default passed (58.6 s).
