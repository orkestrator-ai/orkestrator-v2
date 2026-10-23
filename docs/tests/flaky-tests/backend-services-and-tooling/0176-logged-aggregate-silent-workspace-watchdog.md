# Logged aggregate killed while the workspace group was still running

- **ID:** 0176
- **Status:** resolved
- **Date observed:** 2026-09-30
- **Test:** the whole aggregate, not a test case
- **File:** `scripts/test-all.ts`, `scripts/run-logged.ts`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
  at 7d318875, which is the form `AGENTS.md` prescribes for every suite.
- **Worker configuration:** four aggregate groups; workspace 2 slots, root 3,
  bridges 2, protocol 1, on a 12-core host at load average 4–9.
- **Failure:** `[orkestrator-test-runner] No output for 300000ms; terminating
  the group process tree.` at 418.7 s. Codex protocol (0.4 s), bridges
  (106.0 s) and root (118.6 s) had passed. The workspace group was killed with
  no failing test reported.
- **Isolated rerun:** not applicable. The group was healthy; the wrapper killed it.

## Cause

`run-logged.ts` runs its command as one group through `defaultRunGroup`, which
arms the same five-minute no-progress watchdog that `test-all.ts` gives each
of its own groups. `test-all.ts` streams each group's output into that
group's log file and prints only one line to stdout when a group finishes. Once
the fast groups had finished at 118.6 s, the aggregate was silent for as long
as the workspace group kept running. That group's own budget is documented as
about four minutes on a cold cache, and several flake entries record it at 400
to 740 s under load. At 300 s of silence the wrapper killed a healthy run. The
wrapper watchdog fires whenever the slowest group outlasts the fastest by five
minutes, so the failure depends on host load, like a flake.

## Resolution (2026-09-30)

`runAllTests` now prints `STILL RUNNING <group> (<elapsed>)` for every
unfinished group once a minute. The interval is capped at half the configured
no-progress budget, so a shortened `ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS`
still gets a beat inside its window. Each group's own no-progress and absolute
watchdogs are unchanged. A wedged group is still killed by its own watchdog;
the heartbeat only shows that the aggregate process is alive.
`tests/unit/test-all.test.ts` covers the heartbeat: it names only the running
group, and it stops when the run ends.
