# Container bridge without reachability service times out in the aggregate

- **ID:** 0196
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Test:** `Electron backend command registry > starts a container bridge without a reachability service`
- **File:** `apps/backend/tests/commands-registry-servers.test.ts:1683`
- **Original command:** `mise run test:logged -- --name gnu-full-suite -- mise run test`, with the GNU-tool PATH documented in the testing guide.
- **Worker configuration:** Workspace/root/bridges/protocol groups used 2/3/2/1 worker slots; root files used three isolated Bun workers.
- **Failure:** Five-second outer test timeout; Bun killed one dangling process (5003.01 ms).
- **Suite counts:** Root/support: 5005 passed, 24 skipped, 6 failed, 1 error; 5035 tests across 253 files.
- **Isolated rerun:** `mise run test:logged -- --name registry-servers-alone -- bun test ./apps/backend/tests/commands-registry-servers.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH → passed, exit 0 (26.8 seconds for the owning file).
- **Hypothesis:** The test starts a health server and creates a fake container bridge under a five-second outer deadline. The aggregate timeout and isolated pass establish load-sensitive behavior; the failure does not identify which startup await exhausted the deadline.
- **Evidence:** Failure artifact `orkestrator-test-run.l9axLU/root-and-agent-support-tests.log.gz` in the platform temporary directory; passing output was deleted by the logged runner.

No assertion, timeout, or skip was changed.

## Move-fix validation recurrence — 2026-10-12

- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** Two additional cases in the same owner timed out: `keeps the in-container Claude bridge on its bun entrypoint` (5002.41 ms) and `starts, replaces, and reuses an authenticated container OpenCode server` (5001.29 ms).
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-servers-isolated -- bun test ./apps/backend/tests/commands-registry-servers.test.ts --parallel=1 --only-failures` passed, exit 0, in 51.2 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis:** subprocess deadlines under concurrent host load remain plausible; the isolated pass does not establish a root cause. No timeout, assertion or skip was changed.

## Resolution (2026-11-15)

- **Root cause:** Starting a container bridge through fake Docker exceeded Bun's 5 s default; the owner itself takes 27–51 s alone across its cases.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
