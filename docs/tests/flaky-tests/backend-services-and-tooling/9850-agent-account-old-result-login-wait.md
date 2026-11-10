# An old login result does not settle within the test's polling budget

- **ID:** 9850
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `agent accounts > signing the active account in again > an old result cannot cancel a newer operation`
- **File:** `apps/backend/src/core/agent-accounts.test.ts` (assertion at line 773 in this worktree)
- **Command:** `mise run test:logged -- --name account-removal -- bun test --cwd apps/backend ./src/core/agent-accounts.test.ts --parallel=1 --only-failures`
- **Workers:** one, while the required default and browser validation reruns were also running on the host.
- **Failure:** `login did not settle` from `settledLogin`; the case took 2601.67 ms. The complete owner reported 46 passed and one failed across 47 tests in 25.71 s.
- **Failure evidence:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.6Ddp4M/account-removal.log.gz`.
- **Isolated rerun:** the exact command above, complete owning file, exit 0 in 25.5 s. The logged runner deleted the passing output; separate pass counts were not retained.

The observed case and its polling helper were unchanged. The added regression
in the same file covers removing an inactive saved twin while preserving the
active host login; it passed in both runs. Scheduling pressure is a hypothesis,
not an established cause. No assertion, timeout, or skip was changed to obtain
the passing result.

## Resolution (2026-11-10)

- **Root cause:** `settledLogin` in `agent-accounts.test.ts` gave a sign-in
  200 sleeps of 5 ms to leave `pending`. Settling runs the fake CLI's timers,
  its credential writes and `finishLogin`'s account-store reads and writes;
  on a loaded host that exceeded the count. No product timer is involved:
  `finishLogin` only does storage I/O.
- **Fix:** `settledLogin` waits on the state itself and leaves the bound to
  the test's timeout (a 10 s deadline only ends a loop that outlives a
  timed-out test). The renewal-cancellation case's wait for its temporary
  directory to disappear, the same count-of-sleeps pattern, now waits on the
  directory with the same kind of deadline. No assertion changed.
- **Reproduced:** yes — `mise run test:logged -- --name repro-accounts --
  bun scripts/test-under-contention.ts -- bun test --cwd apps/backend
  --preload ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts
  --rerun-each=5` on the unchanged owner failed 3 of 275 with `login did not
  settle`, including `an old result cannot cancel a newer operation`
  (2341.35 ms). The same command after the fix (`fixed-accounts`) passed.
- **Stress:** `fixed-accounts` above passed 5 reruns of the owner (macOS,
  unpinned burners, host load ~35 to 55).
  A longer run, `mise run test:logged -- --name fixed-accounts-10 -- bun
  scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts
  --rerun-each=10`, also passed.
