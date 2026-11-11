# Rootful container create logs an owned-port listing in the aggregate

- **ID:** 9963
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `465c473d99ee046fe4889c9aa28468c994a5979d`.
- **Observed head:** `merge-button-confusion-7ba4930d15d6-r1` at `ab8580dda`.
  The branch changes the web merge controls, their tests and docs, and only
  three error-message strings in the backend
  (`commands-registry-pr.ts`, `commands-review.ts`, `pr-auto-merge.ts`); it
  does not touch container creation, Docker port handling or this test.
- **File:** `apps/backend/tests/container-rootless-host-ports-create.test.ts:177`
- **Test:** `host ports of a new container > a rootful create leaves automatic ports to Docker and adds no label`
- **Failure:** `expect(docker.split("\n").some((entry) => entry.startsWith("ps "))).toBe(false)`,
  Expected false, Received true (152.78 ms). The published-port and label
  assertions before it passed, so the create itself was rootful; the fake
  Docker log also held a `ps ` call.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite, backend package at its default parallel worker count) on
  Linux x86_64, 16 cores.
- **Suite counts:** backend 18,451 passed and 1 failed; web 14,478 passed and
  4 failed, all in the open flake
  [9932](../native-agents-and-transcripts/9932-virtuoso-cancellation-fake-clock-timer-count.md);
  CLI 517 passed; the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's automatic rerun of the unchanged
  owning file reported `PASSED ALONE (1.1s)`. A later one-worker run,
  `mise run test:logged -- --name rootless-host-ports-alone -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts tests/container-rootless-host-ports-create.test.ts --parallel=1 --only-failures`,
  also passed.
- **Evidence:** the review package's `validation-04.stderr.txt` (lines
  3060–3077) under `.orkestrator/review-artifacts/review-validation-085f2243-54bc-4625-8ead-8f255e326766/`
  in that worktree.

## Recurrence — 2026-11-11 (provisional captures review repairs)

Observed 2026-11-11 on `provisional-captures-510c8fc4900c-r1` (head `e188947f2`), base commit `963ffa6ab70bcc7e412e9748078cdbc0333a7ad1`
(`mise run flaky:recurrence 9963 --base 963ffa6ab…` answered "open. Record
the failure as a recurrence"). The branch changes only backend change-tracking code, the worktree watcher, a benchmark script and documentation; it touches nothing under `apps/web/` and no container code.

- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  on beelink (Linux x86_64, 16 cores), guard stage skipped for an unrelated
  `main` finding; host load average about 35 to 42 at the end of the run.
- **Failure:** the same case, Expected false, Received true.
- **Suite counts:** backend 18,020 pass and 1 fail; web 14,637 pass and 1
  fail ([9932](../native-agents-and-transcripts/9932-virtuoso-cancellation-fake-clock-timer-count.md));
  the other groups passed.
- **Isolated rerun:** the runner's own rerun reported `PASSED ALONE (1.2s)`.

## Hypothesis

Unconfirmed. The assertion reads the whole fake Docker log written during
`create()` (`withDockerScript`, `container-lifecycle-fixtures.ts`). A `ps`
call that something other than the rootful create path makes while the log
is open (a background probe or sweep the fixture starts, delayed onto that
window by a loaded host) would satisfy `startsWith("ps ")` without the
create listing owned ports. Reproduce it first (for example under
`scripts/test-under-contention.ts`) and log which caller issued the `ps`
before changing the test; do not loosen the assertion.
