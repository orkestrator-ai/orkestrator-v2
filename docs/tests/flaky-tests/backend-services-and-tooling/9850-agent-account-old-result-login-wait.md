# An old login result does not settle within the test's polling budget

- **ID:** 9850
- **Status:** open
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
