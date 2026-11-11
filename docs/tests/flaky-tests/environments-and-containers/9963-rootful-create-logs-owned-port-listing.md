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

## Hypothesis

Unconfirmed. The assertion reads the whole fake Docker log written during
`create()` (`withDockerScript`, `container-lifecycle-fixtures.ts`). A `ps`
call that something other than the rootful create path makes while the log
is open (a background probe or sweep the fixture starts, delayed onto that
window by a loaded host) would satisfy `startsWith("ps ")` without the
create listing owned ports. Reproduce it first (for example under
`scripts/test-under-contention.ts`) and log which caller issued the `ps`
before changing the test; do not loosen the assertion.
