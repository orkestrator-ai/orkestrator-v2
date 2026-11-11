# Virtuoso cancellation: fake-clock timer count after the deadline window

- **ID:** 9932
- **Status:** open
- **Date observed:** 2026-11-10
- **File:** `apps/web/src/lib/transcript-scroll/virtuoso-cancellation.test.tsx:95`

## Observation

Observed 2026-11-10 on `speed-up-tests-13519821d63c-r1`, based on
`2aad83a37696d93b6df47420faecf647cf916c8e`, in the review-preparation run of
the default suite (`mise run test`; the web package used its default worker
count). The cases were introduced by this branch's commit `f2787ec8e`, which
moved them onto Bun's fake clock.

Three cases failed with `expect(jest.getTimerCount()).toBe(0)`, Expected 0,
Received 1, at line 95 (`elapsePastEveryDeadline`), called from lines 328 and
423:

- `patched Virtuoso navigation cancellation > restored snapshot transitions from hidden to visible (cancel=%s)`
- `patched Virtuoso navigation cancellation > controller %s reveals a snapshot whose initial navigation is still pending`

The aggregate runner's automatic rerun reported `PASSED ALONE (1.2s): likely
a load flake` for the owning file. Suite counts for that run were not
preserved in the review evidence.

## Isolated rerun

The unchanged owning file passed alone in the aggregate runner's rerun
(1.2 s). Before the fix, 16 concurrent copies of the unchanged file
(`git show HEAD:<file>` copied beside it, 16 parallel `bun test` processes)
also passed, so the failure was not reproduced locally.

## Resolution (2026-11-10)

- **Root cause:** the helper asserted a global zero timer count straight
  after a fixed amount of fake time. `elapseFakeTime` interleaves Happy DOM
  animation frames, which run on real immediates outside the fake clock, with
  fake-timer advances and ends with one more real frame. Under load,
  frame-driven Virtuoso work can arm another fake timer after the last advance
  and before the count is read, so the count is 1 although nothing is late.
  This is an evidence-backed hypothesis; it was not reproduced.
- **Fix:** `elapsePastEveryDeadline` in the owning file now grants up to three
  further windows of the same length, advancing the fake clock again only
  while a timer is still pending, and then asserts the global count is zero.
  A timer that keeps re-arming itself still fails the assertion, and every
  caller's no-further-write and visibility assertions still see any write a
  late timer makes.
- **Reproduced:** no — the failure did not occur locally before the fix, even
  with 16 concurrent runs of the unchanged file; the fix is supported only by
  stress runs, which is weaker evidence.
- **Stress:** `mise run test:logged -- --name stress-virtuoso-cancel -- bun scripts/test-under-contention.ts -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --rerun-each=20`
  passed (280 of 280 tests, 6 unpinned burners on macOS), and 12 concurrent
  runs of the fixed file passed 14 of 14 each.

## Recurrence — 2026-11-10 (releases page review repairs)

Observed 2026-11-10 on `releases-page-b2c7d73cdbc4-r1`, base commit
`53340356c51e6bdb6f86cb6d806575218bbbc6bd`, which contains the fix above
(`mise run flaky:recurrence -- 9932 --base 53340356c5` reported a real
recurrence). The branch changes only `apps/web-public` and docs; it does not
touch this file or the transcript-scroll code.

- **Command:** `mise run test:logged -- --name test-rerun -- mise run test`
  (default suite, web package at its default `bun test src --parallel`
  worker count). A one-worker component Playwright run overlapped it, and the
  host load average was about 41 on 16 cores from unrelated work.
- **Failure:** four cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`, after the
  bounded extra settle rounds), called from `shrinkViewport` (line 243) and
  line 343:
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (78.8 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (64.5 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (35.1 ms, 19.6 ms)
- **Suite counts:** web 14,450 passed and 4 failed; every other group passed
  (backend 18,326, protocol 5,813, desktop 2,049, web-public 52, toolchain 135,
  CLI 517, plus the root, bridge and lockfile groups).
- **Isolated rerun:** the aggregate runner's automatic rerun reported
  `PASSED ALONE (834ms)` for the unchanged owning file.

The three extra settle windows did not absorb the late timer under this load,
so the hypothesis (a Happy DOM frame arming one more fake timer after the last
advance) still fits, but the bounded settle is not a sufficient fix. Status
reopened; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (egress name-check review repairs)

Observed 2026-11-11 on `egress-name-checks-99a7933a4d12-r1`, base commit
`498b68766f5c9f357a3a86782406d1e9e0977559` (`mise run flaky:recurrence --
9932 --base 498b68766f` reported the case open). The branch changes
`apps/web/src/components/environments/EnvironmentNetworkPolicyStatus*`,
one line of `ServiceBrowserTab.test.tsx`, a daemon unit test and docs; it
does not touch this file or the transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite, web package at its default `bun test src --parallel`
  worker count). Host load average about 73 on 16 cores from other
  worktrees' runs.
- **Failure:** five cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`):
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (40.5 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (31.5 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (60.6 ms, 59.0 ms)
  - `controller deactivation reveals a snapshot whose initial navigation is still pending` (45.3 ms)
- **Suite counts:** web 14,472 passed and 5 failed; backend 18,369, protocol
  5,817, desktop 2,033, web-public 52, toolchain 135 and CLI 517 passed.
- **Isolated rerun:** the aggregate runner's automatic rerun, queued behind
  another worktree's exclusive resource, reported `FAILED ALONE (2.3s)` with
  six cases (adding `cancelling before the refresh retires the queued
  follow: no LAST write` and `a literal false follow prop never scrolls on
  growth`). A later manual rerun,
  `mise run test:logged -- --name virtuoso -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`,
  passed (1.0 s).

A second complete `mise run test` on the same branch (head `5cff101fa`,
load average 61 to 72) failed nine cases of this file in the web group
(14,469 passed), and the runner's rerun again reported `FAILED ALONE (1.4s)`
(two `restored snapshot` cases). Three manual single-file reruns with
`--parallel=1` at that load gave 8 pass / 6 fail, 14 pass / 0 fail and
7 pass / 7 fail, so at this load the file fails alone about two runs in three.

This is the first observation where the runner's single-file rerun also
failed: under heavy host load one rerun is not enough to clear the late
timer, which still fits the Happy DOM frame hypothesis. Status stays open.

## Recurrence — 2026-11-11 (container probe rerun review repairs), fails alone under load

Observed 2026-11-11 on `container-probe-rerun-6defadbc4752-r1`, base commit
`498b68766f5c9f357a3a86782406d1e9e0977559`, which contains the fix above
(`mise run flaky:recurrence -- 9932 --base 498b68766` answered "open. Record
the failure as a recurrence"). The branch changes container test harnesses,
the UI perf probe, docs and one assertion in
`apps/web/src/components/browser/ServiceBrowserTab.test.tsx`; it does not
touch this file or the transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (default suite, web package at its default worker count). The host load
  average was 61–65 on 16 cores from other worktrees' work, and the aggregate
  runner's scheduler reported 14–16 of 16 slots reserved.
- **Failure:** three cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`, after the
  bounded extra settle rounds):
  - `literal false: a detached reader is not moved when the viewport shrinks` (24.9 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (16.1 ms, 22.4 ms)
- **Suite counts:** web 14,466 passed and 3 failed; backend 18,370,
  protocol 5,817, desktop 2,033, web-public 52 and toolchain 135 passed, as
  did the root, bridge and lockfile groups.
- **Isolated rerun:** as in the egress name-check observation above, the
  file **failed alone** too. The aggregate runner's automatic rerun reported
  `FAILED ALONE (589.5s)` (2 of 14 failed, after waiting 588 s for a slot),
  and four further one-worker runs at the same load failed 8, 9, 7 and 7 of
  14 cases with the same assertion
  (`bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --only-failures`,
  three with `NODE_ENV=test`, one without). The extra cases include
  `indexJumpThenRefresh` (line 140) and `followThenRefresh` (line 177) callers.

At a load average around 60, the late timer is no longer an aggregate-only
effect: one process on its own leaves a fake timer pending after every
settle round. That still fits the Happy DOM real-immediate frame hypothesis,
and it gives a way to reproduce it: run the file alone on a host loaded to
about four times its core count. No assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (coordinator tab-group review repairs)

- **Base:** `498b68766f5c9f357a3a86782406d1e9e0977559`; `mise run flaky:recurrence -- 9932 --base 498b68766…` answered `open`.
- **Observed head:** `coordinator-tab-groups-93e8abebd558-r1` at `1dffbbfac`
  (coordinator layout store and plan-usage URL changes); nothing under
  `apps/web/src/lib/transcript-scroll/` is touched.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name review-default-tests-skip-guards -- mise run test`
  on macOS, on a host shared with other worktrees' suites (1400.9 s).
- **Failure:** five cases failed with `expect(jest.getTimerCount()).toBe(0)`
  at line 110 (`elapsePastEveryDeadline`), called from lines 210, 248, 255
  and 343 (twice): `a literal false follow prop never scrolls on growth`,
  `a function follow prop that answers false is still truthy to the viewport-shrink path`,
  `literal false: a detached reader is not moved when the viewport shrinks`
  and `restored snapshot transitions from hidden to visible (cancel=%s)` (both).
- **Suite counts:** web 14,474 passed and 5 failed; backend 18,326 passed and
  4 failed (all case 9936's `maintenance.lock` copy race); root, bridge and
  lockfile groups passed.
- **Isolated rerun:** `mise run test:logged -- --name rerun-virtuoso -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`
  passed (0.9 s). The aggregate runner's own rerun was not reached: its 600 s
  budget went to a file queued for host capacity.

## Recurrence — 2026-11-11 (Claude read-only settings connection review repairs)

Observed 2026-11-11 on `sandbox-settings-issue-d5843d587d48-r1`, base commit
`498b68766f5c9f357a3a86782406d1e9e0977559`, which contains the fix above
(`mise run flaky:recurrence -- 9932 --base 498b68766` reported the case open
and asked for the recurrence to be recorded). The branch changes the Claude
bridge, one protocol log vocabulary entry, an Agent Info test and docs; it
does not touch this file or the transcript-scroll code.

- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test` (default suite,
  web package at its default `bun test src --parallel` worker count; guards
  skipped because of an unrelated source-guard finding in
  `ServiceBrowserTab.test.tsx`). Host load average about 12 on 16 cores.
- **Failure:** seven cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`), among them:
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (25.3 ms)
  - `a literal false follow prop never scrolls on growth` (24.2 ms)
  - `cancelling before the refresh retires the queued follow: no LAST write` (18.7 ms)
  - `control: an append while following publishes the queued follow` (29.8 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (40.7 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (22.4 ms, 34.8 ms)
- **Suite counts:** web 14,463 passed and 7 failed (14,480 run); backend
  18,369 passed, CLI 517 passed, every other workspace task passed (Turbo: 12
  of 13 tasks successful), and the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's automatic rerun reported
  `PASSED ALONE (1.0s)` for the unchanged owning file.

Status stays open; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (merge button review)

Observed 2026-11-11 on `merge-button-confusion-7ba4930d15d6-r1` at
`ab8580dda`, base commit `465c473d99ee046fe4889c9aa28468c994a5979d`
(`mise run flaky:recurrence -- 9932 --base 465c473d9` answered "open. Record
the failure as a recurrence"). The branch changes the web merge controls
(`components/layout`, `kanban/ticket-view`, `build-pipeline`), their tests,
docs and three backend error strings; it does not touch this file or the
transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite, web package at its default worker count).
- **Failure:** four cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`):
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (32.3 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (19.2 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (14.2 ms, 7.9 ms)
- **Suite counts:** web 14,478 passed and 4 failed; backend 18,451 passed and
  1 failed (flake
  [9963](../environments-and-containers/9963-rootful-create-logs-owned-port-listing.md));
  CLI 517 and the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's automatic rerun reported
  `PASSED ALONE (851ms)`, and a later
  `bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --only-failures`
  (`NODE_ENV=test`, host load average about 4 on 16 cores) passed.

## Recurrence — 2026-11-11 (CLI and slash-command qualification review repairs), fails alone under load

Observed 2026-11-11 on `cli-slash-qualification-024da345b17c-r1` at
`e3459a948`, base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes the CLI scenario harness
(`packages/cli/scenarios`, `packages/cli/scripts`), adds
`scripts/qualify-slash-mixed-versions.ts` and edits to-do docs; it does not
touch `apps/web`.

- **Command:** `mise run test:logged -- --name review-default-tests-fix-rerun -- mise run test`
  (default suite, web package at its default worker count).
- **Failure:** four cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`):
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (25.7 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (17.1 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (17.8 ms, 23.1 ms)
- **Suite counts:** web 14,575 passed and 4 failed; backend 18,573 passed and
  0 failed; the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's automatic rerun waited for host
  capacity and ended `INCOMPLETE` after 600 s with no verdict. Three manual
  runs of `bun test ./src/lib/transcript-scroll/virtuoso-cancellation.test.tsx`
  from `apps/web` with `NODE_ENV=test`, at a host load average of about 74 on
  16 cores, failed alone: 9, 5 and 9 of 14 cases, each with the same
  Received 1 signature. This matches the earlier "fails alone under load"
  recurrence. (Without `NODE_ENV=test` the shell's `NODE_ENV=production`
  loads React's production build and every case fails with
  `React.act is not a function`, which is unrelated to this flake.)

## Recurrence — 2026-11-11 (streaming compression review repairs), fails alone under load

Observed 2026-11-11 on `streaming-compression-fixes-a3d14897aa2a-r1` at
`070820ff9`, base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes backend gateway metrics,
gateway tests, a probe script and docs; it does not touch `apps/web` or the
transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (default suite, web package at its default worker count), rerunning the
  review's incomplete default-suite run.
- **Failure:** four cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`):
  - `a function follow prop that answers false is still truthy to the viewport-shrink path` (67.8 ms)
  - `literal false: a detached reader is not moved when the viewport shrinks` (45.7 ms)
  - `restored snapshot transitions from hidden to visible (cancel=%s)` (73.1 ms, 28.9 ms)
- **Suite counts:** web 14,575 passed and 4 failed; backend 18,590 passed and
  0 failed; CLI 517 passed; the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's automatic rerun queued for host
  capacity and ended `INCOMPLETE` after 600 s with no verdict. Run by hand
  with `NODE_ENV=test bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`,
  the file passed 14 of 14 earlier in the session. At a load average of
  about 89 to 91 on 16 cores it then failed alone three times, with 9 or 10 of
  14 cases failing, all with Received 1.

## Recurrence — 2026-11-11 (design conversation links fix round)

Observed 2026-11-11 on `conversation-links-de945f872863-r1` at `19a9c9550`,
base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes the design canvas's agent
links, the design perf harness and their tests and docs; it does not touch
this file or the transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (default suite, web package at its default worker count).
- **Failure:** nine cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`), among them
  `control: without cancellation the library retries the index target after a refresh`
  (206.8 ms) and both `restored snapshot transitions from hidden to visible (cancel=%s)`
  cases.
- **Suite counts:** web 14,576 passed and 9 failed; backend 18,582 passed and
  0 failed; CLI 517; the root, bridge and lockfile groups passed.
- **Isolated rerun:** the aggregate runner's own rerun of the file waited for
  host capacity and was still running when the 30-minute group deadline ended
  the run. Two manual one-worker runs,
  `NODE_ENV=test bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`,
  at a host load average of about 57 on 16 cores, failed 5 and 10 of 14 cases
  with the same `Received: 1`, matching the earlier high-load recurrences.

## Recurrence — 2026-11-11 (backend domain restructure review repairs)

Observed 2026-11-11 on `backend-domain-restructure-13639d788e59-r1` at
`98f77e1d0`, base `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch moves backend web-annotation
modules and edits docs and a codemod script; its only web change is one
comment in `apps/web/src/stores/conversationScrollTargetStore.ts`, outside
the transcript-scroll code.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  on a host with 14 to 16 of 16 scheduler slots reserved.
- **Failure:** `expect(jest.getTimerCount()).toBe(0)`, Expected 0,
  Received 1, at line 110 (`elapsePastEveryDeadline`), in at least
  `control: an append while following publishes the queued follow` (71.5 ms),
  `cancelling before the refresh retires the queued follow: no LAST write`
  (14.1 ms) and `a literal false follow prop never scrolls on growth` (11.5 ms).
- **Suite counts:** web 14,571 pass, 10 skip, 8 fail (14,589 tests across
  1,008 files, 470.2 s); the eight failures are in this file and
  `useConversationScrollTarget.test.tsx` (case
  [9983](9983-conversation-scroll-target-repeat-jump-highlight.md)).
- **Isolated rerun:** `NODE_ENV=test bun test ./src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`
  from `apps/web`, through `test:logged`: passed (0.4 s).

Status stays open; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (backend domain restructure, review round 2)

Observed 2026-11-11 on `backend-domain-restructure-13639d788e59-r1` at
`78e449ad3`, base `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch's only web change is still the one
comment in `apps/web/src/stores/conversationScrollTargetStore.ts`; this file's
local import graph (140 files) does not reach it.

- **Command:** `mise run test:logged -- --name review-default-tests-rerun -- mise run test`,
  host load average 47 to 76 on 16 cores.
- **Failure:** `expect(jest.getTimerCount()).toBe(0)`, Expected 0,
  Received 1, at line 110 (`elapsePastEveryDeadline`), in eight cases,
  among them `restored snapshot transitions from hidden to visible (cancel=%s)`
  (14.5 ms, 11.2 ms), `control: an append while following publishes the queued follow`
  and `a literal false follow prop never scrolls on growth`.
- **Suite counts:** web 14,571 pass, 8 fail (14,589 tests across 1,008 files,
  620.2 s), all eight in this file. Backend 18,573, desktop 2,143, protocol
  5,830, CLI 517, toolchain 135, web-public 52, root 4,515 and all five
  bridges passed with 0 failures. The runner's automatic solo rerun was cut
  off by the 1,800 s group deadline (INCOMPLETE, no verdict).
- **Isolated rerun:** `NODE_ENV=test bun --cwd=apps/web --no-env-file test ./src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`
  through `test:logged`, four times at a load average of 77 to 79: failed
  each time (6, 10, 10 and 10 of 14 cases, all Received 1). As in the second
  2026-11-11 recurrence above, the file fails alone at this load; it passed
  alone at lower load in earlier recurrences.

Status stays open; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (terminal visible-text review repairs)

Observed 2026-11-11 on `terminal-event-reproduction-58a6a9a0fc85-r1`
(head `e4777ac3a`), base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence 9932 --base 14df96544…` answered "open. Record
the failure as a recurrence"). The branch changes only documentation, two
agent-testing Electron specs, the headless Electron spec list and its unit
test; it does not touch this file or anything under `apps/web/`.

- **Command:** `env -u NODE_ENV mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  on beelink2 (Linux x86_64, 16 cores), with the browser suite running
  alongside it and a host load average of 35 to 67.
- **Failure:** ten cases with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`), including
  `control: without cancellation the library retries the index target after a
  refresh`, `controller deactivation reveals a snapshot whose initial
  navigation is still pending` and both `restored snapshot transitions from
  hidden to visible (cancel=%s)` cases.
- **Suite counts:** web 14,569 pass and 10 fail; the backend ([9978](../coordinator-and-multi-review/9978-coordinator-wakes-and-git-mirror-timeouts-under-load.md)) and CLI
  ([9982](../backend-services-and-tooling/9982-scenario-provider-homes-mise-warning-under-load.md)) failures are recorded in their own cases; the root, bridge, guard
  and lockfile groups passed.
- **Isolated rerun:** the runner's own rerun reported `FAILED ALONE (1.7s)`,
  and a manual `bun test` of the file from `apps/web` at the same load failed
  9 of 14. Once the load average fell to about 17,
  `bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --only-failures`
  passed.
- **Note:** an earlier rerun from the same shell inherited
  `NODE_ENV=production` from the agent session. React's production build then
  failed every case of this file with `React.act is not a function`; that is
  the environment, not this flake, which is why the runs above unset it.

## Recurrence — 2026-11-11 (Effect adoption follow-ups review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `da475cb5e`,
base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes only `apps/backend` MCP
evidence, provider-read and transcript-artifact code, their tests and docs;
it does not touch this file or the transcript-scroll code.

- **Command:** `mise run test:logged -- --name address-default-tests -- mise run test`
  (default suite at its default worker counts) on Linux x86_64, 16 cores, host
  load average about 60.
- **Suite counts:** backend 18,578 passed and 3 failed (flakes 9963 and 9978);
  web 14,572 passed and 7 failed (flake 9932); protocol, desktop, web-public,
  toolchain, CLI, root, bridge and lockfile groups passed.
- **Failure:** seven cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`), among them
  `control: an append while following publishes the queued follow` (40.2 ms)
  and both `restored snapshot transitions from hidden to visible (cancel=%s)`
  cases.
- **Isolated rerun:** the aggregate runner's rerun budget was spent on another
  file, so it did not rerun this one. Three manual runs of
  `NODE_ENV=test mise run test:logged -- --name rerun-virtuoso-alone-N -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --only-failures`
  at a load average of about 59 failed 9, 6 and 9 of 14 cases with the same
  assertion, matching the earlier loaded solo failures. (Without
  `NODE_ENV=test` every case fails instead with `React.act is not a function`,
  because React's production build loads; that is an invocation error, not
  this flake.)

Status stays open; no assertion, timeout or skip changed.

## Recurrence — 2026-11-11 (Effect adoption follow-ups, second review repairs)

Observed 2026-11-11 on `adoption-follow-ups-0b2001052718-r1` at `b307c086f`,
base commit `14df965440e658e09a7b3ce03530bc1781ac2b01`
(`mise run flaky:recurrence -- 9932 --base 14df96544` answered "open. Record
the failure as a recurrence"). The branch changes no `apps/web` code.

- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  (default suite at its default worker counts) on Linux x86_64, 16 cores, with
  the shared host queueing behind other worktrees' runs.
- **Suite counts:** backend 18,593 passed and 1 failed (flake 9963); web 14,570
  passed and 9 failed (this case); root, bridge and lockfile groups passed.
- **Failure:** nine cases failed with `expect(jest.getTimerCount()).toBe(0)`,
  Expected 0, Received 1, at line 110 (`elapsePastEveryDeadline`), among them
  `control: without cancellation the library retries the index target after a refresh`
  (148.9 ms) and both `restored snapshot transitions from hidden to visible (cancel=%s)`
  cases.
- **Isolated rerun:** the aggregate runner's rerun budget was spent before it
  reached this file. Two manual runs of
  `NODE_ENV=test mise run test:logged -- --name virtuoso-alone-test-env-N -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1`
  passed (14 of 14, load average about 11 after the suite finished).

Status stays open; no assertion, timeout or skip changed.
