# Parent-bound command output includes Bash trap warnings

- **ID:** 7341
- **Status:** open
- **Date observed:** 2026-11-06
- **Test/file:** `spawnParentBoundCommand > passes the command's output and exit status through`, `apps/backend/tests/shell.test.ts:388`.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, commit `97edef141`, macOS arm64, Bun 1.4.4. The workspace group reserved six slots; the backend ran with four Bun workers.
- **Failure:** at 49.12 ms, stdout and exit status matched, but stderr contained `err` followed by `orkestrator-follower: warning: run_pending_traps: bad value in trap_list[15]: 0x0` and `orkestrator-follower: warning: run_pending_traps: signal handler is SIG_DFL, resending 15 (SIGTERM) to myself`.
- **Isolated rerun:** `mise run test:logged -- --name address-shell -- bun --cwd=apps/backend test ./tests/shell.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0, 1.3 s. The logged runner deleted passing output, so assertion counts were not retained.
- **Suite counts:** the backend never produced final counts: its workspace group stopped for 300,000 ms without output. Turbo reported 12 successful tasks of 13, with the backend test task terminated; the aggregate exited 1 after 747.6 s. The root group separately reported 3,747 passed and three deterministic failures.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.zf6WAr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and the adjacent `summary.json`. The outer logged command retained `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.EdgWr8/review-default-tests.log.gz`.
- **Hypothesis / fix:** Bash reported a signal-trap warning while the follower exited. The triggering interleaving is unproved. Neither the shell implementation nor its owning test changed on this branch. No assertion, timeout or skip was changed.
