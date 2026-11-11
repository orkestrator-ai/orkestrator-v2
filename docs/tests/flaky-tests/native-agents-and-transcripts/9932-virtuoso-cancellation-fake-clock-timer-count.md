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
