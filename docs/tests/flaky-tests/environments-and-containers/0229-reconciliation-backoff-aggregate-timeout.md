# Environment reconciliation backoff times out in the aggregate

- **ID:** 0229
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `Electron backend command registry > backs off failed reconciliation for 30 seconds and clears the floor after success`
- **File:** `apps/backend/tests/commands-registry-environments-create.test.ts`
  (observed at its earlier path, `tests/unit/electron/commands-registry-environments-create.test.ts`)
- **Original command:** the testing guide's GNU-tool PATH with
  `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** standard workspace/root/bridges/protocol slots
  2/3/2/1; root files ran in three isolated Bun workers. Browser validation
  also ran on this host.
- **Failure:** five-second timeout, reported at 5005.15 ms, followed by a
  late fixture assertion error between tests.
- **Suite counts:** root/support 5,073 total, 5,041 passed, 24 skipped,
  eight failures and three additional errors across 256 files (375.09 seconds).
- **Isolated rerun:**
  `mise run test:logged -- --name reconciliation-backoff-isolated -- bun test ./tests/unit/electron/commands-registry-environments-create.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, in 48.2 seconds. The aggregate workspace group
  and other individual-file reruns were still running on the host.
- **Failure evidence:**
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.bM95Aj/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the aggregate run exhausted the outer five-second budget;
  the owning file passed without sibling files in its Bun process. The stalled
  await and the root cause remain unconfirmed. No timeout, assertion or skip
  was changed.

Case 0202 tracks a different test in the same file.

## Recurrence during firewall tuple validation (2026-10-15)

`mise run test:logged -- --name root-tests -- mise run test` timed out this
unchanged test at 5003 ms. The next case, `lets an explicit first prompt bypass
rename retry backoff`, then observed one update instead of two, and the late
rename attempted to use an already removed fake Codex executable. The browser
component and isolated-browser suites were also running. The owning file passed
unchanged alone in 9.7 seconds with `--parallel=1`:

```bash
mise run test:logged -- --name reconciliation-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-create.test.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.aDyLLJ/root-tests.log.gz`. No assertion,
implementation, skip or timeout was changed for these cases.

## Cross-service read policy final validation recurrence — 2026-10-23

`mise run test` on the 0054 branch merged with `origin/main` at `cda435fc9` (no command-registry source changes) timed out at 5000.49 ms, alongside two neighbouring rename cases. The complete owning file then passed alone twice (52 passed, 24.6 s and 20.9 s) after one alone failure in the A-to-B-to-A rename case. Details in [0696](../aggregate-validation-runs/0696-cross-service-reads-validation.md). No assertion, timeout or skip changed.
