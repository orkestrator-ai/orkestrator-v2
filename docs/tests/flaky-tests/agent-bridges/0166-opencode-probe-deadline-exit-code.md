# OpenCode compatibility probe deadline sees no exit code under aggregate load

- **ID:** 0166
- **Status:** open
- **Date observed:** 2026-09-26
- **Test:** `runOpenCodeLiveCompatibility > kills the server when the overall deadline expires`
- **File:** `scripts/opencode-live-compatibility-probe.test.ts`
- **Original command:** `mise run test` on branch
  `implement-improvements-ecf7c41c13cd-r1`. Neither the probe script nor
  `apps/web/src/lib/opencode-client.ts` is changed by this branch.
- **Worker configuration:** root group (3 worker slots) concurrent with the
  workspace, bridges and codex-protocol groups.
- **Failure:** at `scripts/opencode-live-compatibility-probe.test.ts:378`,
  `expect(server.exitCode).toBe(0)` received `null` 166.86 ms into the test:
  the probe rejected on its 10 ms deadline, but the killed fixture server had not
  reported its exit yet.
- **Isolated rerun:**
  `mise run test:logged -- --name oc-probe-N -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  passed three times in a row.

## Current assessment

The assertion reads `exitCode` synchronously after the probe rejects. Under
load the child's exit event can arrive after that read. Likely fix: await the
fixture process's exit (bounded) before asserting its code. Keep open until
fixed or seen again.

## Resolution (2026-09-30)

The original hypothesis (a late exit event) was wrong: the fake server sets
`exitCode` synchronously in `kill()`. The real cause was a leak in the probe
itself. The 10 ms deadline could expire while the probe was still creating its
temp root (`mkdtemp` plus four `mkdir` calls, which are slow under load). The
deadline branch then ran the teardown with no server yet, removed the root, and
rejected. The abandoned probe carried on and spawned a server nothing would
ever stop, so `server.exitCode` stayed `null`. A deadline during the CLI version
read was worse: no teardown was registered yet, so the probe later created
both the root and the server. Against a real `opencode serve` this leaks a
process and a temp directory, which the deadline exists to prevent.

`probeOpenCode` now takes an abort signal. The deadline aborts it (with the
deadline error as the reason, so either branch rejects the same way) before
tearing down. The probe checks the signal before creating anything and again
just before spawning. The teardown waits for the bounded setup step to settle,
so it never runs ahead of a server that is about to be spawned.

Two regression tests pin both windows: a deadline during port allocation, and
a deadline during the CLI version read. Both failed on the previous
implementation and pass on the new one. The file passed five consecutive runs.

## Recurrence (2026-10-15)

During `mise run test:logged -- --name complete-tests -- mise run test` on
`fix-host-dependent-test-suites-d453802ec96e` (base `dd86fc8c`), the assertion at
line 380 again received `null` instead of `0`, after 16.16 ms. The root group
used one worker alongside four workspace slots, two bridge slots and one
protocol slot. The root result was 2,947 passed, one skipped and two failed;
the other failure was a deterministic DOM-diagnostics contract violation in
new assertions, corrected separately.

The unchanged owning file passed with `mise run test:logged -- --name
opencode-probe-alone -- bun test ./scripts/opencode-live-compatibility-probe.test.ts
--parallel=1 --only-failures` in 0.4 seconds. Evidence is in
`/tmp/orkestrator-test-run.1UFRFF/root-and-agent-support-tests.log.gz`.

Reopened for the recurring symptom, not as proof that the previous leak has
returned. The existing abort-before-spawn fix can legitimately prevent a
server from being created when a 10 ms deadline expires during setup. This
test still assumes setup reaches `spawnServer` before its deadline; aggregate
load may invalidate that assumption. No probe implementation or assertion was
changed in this task.

The root group passed the subsequent `complete-tests-final` full-suite run in
144.4 seconds with the same worker plan. That run's only failure was the
existing backend Git/worktree timeout tracked as 0187.

## Held-send validation recurrence (2026-10-15)

`mise run test:logged -- --name repository-final -- mise run test` reproduced
the same `exitCode` assertion at line 380: expected `0`, received `null`,
test duration 20.55 ms. The root group used one worker; workspace used four,
bridges requested two and protocol one, with groups queued by the shared host
capacity scheduler. Root reported 2,978 passed, one skipped and one failed in
160.04 seconds.

The unchanged owning file passed alone, exit 0, in 0.3 seconds:

```bash
mise run test:logged -- --name opencode-probe-repro -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures
```

Evidence is retained in
`/tmp/orkestrator-test-run.GWGZM4/root-and-agent-support-tests.log.gz`. This matches the existing setup-deadline assumption;
no probe implementation, assertion, timeout or skip was changed.

## Resolution (2026-10-15, second)

The recurrences matched the setup-deadline assumption noted above. The case
started a real 10 ms deadline and expected the server it spawns to be stopped.
Under load, `mkdtemp`, the four `mkdir` calls and port allocation can outlast
10 ms. The deadline then aborts the probe before `spawnServer`, so the fake
server is never started and its `exitCode` stays `null`. That is the correct
behaviour from the 2026-09-30 fix, and the two setup-deadline regression cases
already cover it.

The case now installs `installControlledTimeout(10)` from
`tests/helpers/controlled-timeout.ts` before starting the probe. Its
`listSessions` fake signals when the probe reaches the hung session list, and
only then does the case advance the captured deadline timer. It still asserts
the deadline error, the stopped server (`exitCode` 0), the drained timer and
no leftover temporary root. Wall-clock time is no longer involved. No probe
code, timeout or other assertion changed.

Evidence: a temporary copy of each version with a 40 ms `allocatePort` delay,
which models slow setup. The old case failed with `Expected: 0, Received: null`
(45.6 ms), the same signature as every recurrence. The new case passed. The
owning file passed three consecutive runs with
`mise run test:logged -- --name oc-probe-N -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1`.
Case 0242 (a shared temporary-root prefix across worktrees) is separate and
stays open.

## Recurrence — 2026-10-25 (reopened)

- **Branch:** `todo-0066-residual-module-state-40e8f98a7ef0` (moves backend
  module state into `BackendRuntime`; it does not touch
  `scripts/opencode-live-compatibility-probe*.ts`).
- **Original command:** `mise run test`, reservations 4/1/2/1, root group with
  one worker slot, other worktrees running tests on the same host.
- **Failure:** a different assertion from the original case: `server.exitCode`
  was 0, but `expect(await tempRoots()).toEqual(before)` at line 399 found an
  extra `ork-opencode-compat-vgEpCr` directory in the temporary directory.
  37.93 ms. Root counts: 3414 pass, 1 fail, 3415 tests across 162 files
  (227.75 s). Artifact `orkestrator-test-run.sBEjBh` under the host temporary
  directory.
- **Isolated rerun:** `bun test ./scripts/opencode-live-compatibility-probe.test.ts`
  from the repository root: 31 pass, 0 fail (1.23 s).
- **Hypothesis (not established):** `tempRoots()` lists every
  `ork-opencode-compat-*` entry in the shared OS temporary directory, so a
  probe run by another process or worktree on the same host at that moment
  would appear as a leak. Scoping the listing to roots this test created would
  rule that out.

