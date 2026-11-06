# Interaction fixture cleanup races a macOS child in kernel exit

- **ID:** 9834
- **Status:** resolved
- **Observed:** 2026-11-06 on macOS, Bun 1.4.4
- **Test:** `readiness timeout stops a delayed host and its fake provider, removing their temp files`
- **File:** `tests/unit/interaction-fixture-host.integration.test.ts`

The initial parallel owning-file run failed in 1,010.12 ms with
`kill() failed: EPERM: Operation not permitted`, replacing the expected
startup-timeout error. Two tests passed and one failed (six assertions).
Command:

```sh
mise run test:logged -- --name interaction-host-lifecycle -- bun test ./tests/unit/interaction-fixture-host.integration.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.09B93K/interaction-host-lifecycle.log.gz`.
The same owning-file command passed alone on retry: three tests in 1.7 s.
A ten-run stress check reproduced five failures out of thirty tests; evidence
is in `orkestrator-test-run.TJG6lx/interaction-host-lifecycle.log.gz` under
the same temporary root.

Diagnosis captured the failed signal as SIGKILL after the host exited with
code zero. A remaining fake-provider process was reparented to PID 1 and
reported `?E` by `ps`, the macOS kernel-exit state. A diagnostic stress run
also exposed a 100 ms post-SIGKILL wait that could expire before the host's
exit event was delivered under load. Evidence is in
`orkestrator-test-run.mrSkWj/interaction-host-lifecycle-debug.log.gz`.

The fix in `e2e/interaction-fixture-host.ts` keeps a separate five-second
post-SIGKILL wait and handles EPERM only after the recorded host has exited:
it checks that the owned process group contains only exiting processes or
zombies and waits up to five seconds for it to drain. A live member, failed
inspection or expired bound still fails cleanup. Already stopped hosts are
idempotent; directories are removed only after confirmed cleanup. No test is
skipped and no assertion was loosened.

The repaired stress command passed all ten repetitions of the three tests
(30 executions, 13.2 s):

```sh
mise run test:logged -- --name interaction-host-lifecycle -- bun test ./tests/unit/interaction-fixture-host.integration.test.ts --parallel=1 --only-failures --rerun-each=10
```
