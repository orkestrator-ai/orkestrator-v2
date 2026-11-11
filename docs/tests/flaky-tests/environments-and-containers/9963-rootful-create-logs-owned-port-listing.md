# Rootful container create logs an owned-port listing in the aggregate

- **ID:** 9963
- **Status:** resolved
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

## Recurrence — 2026-11-11 (Effect adoption follow-ups review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `da475cb5e`,
base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9963 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes only `apps/backend` MCP
evidence, provider-read and transcript-artifact code, their tests and docs;
it does not touch this file or the container create path.

- **Command:** `mise run test:logged -- --name address-default-tests -- mise run test`
  (default suite at its default worker counts) on Linux x86_64, 16 cores, host
  load average about 60.
- **Suite counts:** backend 18,578 passed and 3 failed (flakes 9963 and 9978);
  web 14,572 passed and 7 failed (flake 9932); protocol, desktop, web-public,
  toolchain, CLI, root, bridge and lockfile groups passed.
- **Failure:** `host ports of a new container > a rootful create leaves automatic ports to Docker and adds no label`
  (234.5 ms) failed at line 177, `expect(...some(entry => entry.startsWith("ps "))).toBe(false)`,
  Received true: the same fake-Docker `ps ` entry as the first observation.
- **Isolated rerun:** the aggregate runner's rerun budget was spent before it
  reached this file. A manual
  `mise run test:logged -- --name rerun-backend-alone -- bun --cwd=apps/backend test ./src/core/coordinator-status-wakes-pr.test.ts ./tests/project-git-mirror-create.test.ts ./tests/container-rootless-host-ports-create.test.ts`
  passed (19.4 s).

Status stays open; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (Effect adoption follow-ups, second review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `b307c086f`,
base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9963 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes backend read cancellation
(node routing, node link, provider reads, transcript artifacts) and does not
touch this file or the container create path.

- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite at its default worker counts) on Linux x86_64, 16 cores, with
  the shared host queueing behind other worktrees' runs.
- **Suite counts:** backend 18,593 passed and 1 failed (this case); web 14,570
  passed and 9 failed (flake 9932); desktop failed 2 cases in
  `apps/desktop/tests/invoke-envelope-ipc.test.ts`, a real test expectation
  this branch made stale and fixed in the same change; root, bridge and
  lockfile groups passed.
- **Failure:** `host ports of a new container > a rootful create leaves automatic ports to Docker and adds no label`
  (190.2 ms) failed at line 177, Received true: the same fake-Docker `ps `
  entry as before.
- **Isolated rerun:** the aggregate runner's rerun budget was spent before it
  reached this file. A manual
  `NODE_ENV=test mise run test:logged -- --name rootful-create-alone-test-env -- bun --cwd=apps/backend test ./tests/container-rootless-host-ports-create.test.ts`
  passed (0.6 s).

Status stays open; no assertion, timeout or skip changed.

## Resolution — 2026-11-11 (to-do 7569 rework, `docker-fixture-waits-859dbd041c3d-r1`)

**Cause.** The assertion was wider than its claim. The comment says "no
owned-port listing on a rootful daemon", but the check failed on any fake
Docker log line starting with `ps `. The fake script logs every `docker`
invocation made while `PATH` points at it, and the backend has more than a
dozen `docker ps` callers (manifest probe cleanup, container state and usage
reads, gateway listings). In every observation the published-port and label
assertions before it passed: `127.0.0.1::3000/tcp` was published unchanged,
which only the rootful branch of `createDockerContainer` does
(`topology.rootless` decides both the port choice and the listing). So the
create was rootful and the stray `ps` was some other caller, not the owned-port
listing. That caller was not identified: the failures recorded no log text.

**Reproduction.** Not reproduced as it happened: 120 runs of the owning file
under `bun scripts/test-under-contention.ts --burners 8 -- ... --rerun-each=40`
passed. The mechanism is reproduced deterministically instead. The new case
`another docker ps during a rootful create is not taken for the owned-port listing`
issues an unrelated `docker ps -a --no-trunc` through the same fake `docker`
while the create runs. The old check
(`some((entry) => entry.startsWith("ps "))` is `false`) fails on that log; the
new one passes.

**Fix.** The test file's `ownedPortListings` now matches exactly the call
`listOwnedBackendHostPorts` makes (`ps -a --filter label=orkestrator-owner=…`
with the `orkestrator-backend-host-ports` label filter). The rootful case
asserts there is none, and the rootless case now asserts exactly one where it
had asserted a substring. The assertion is not loosened: an owned-port listing
on a rootful create still fails it, and no timeout or skip changed.

**Verification.** `mise run test:logged -- --name rootless-host-ports -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts tests/container-rootless-host-ports-create.test.ts --parallel=1 --rerun-each=5`
passed (4 tests × 5).
