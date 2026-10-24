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

## Session lifecycle review recurrence — 2026-10-23

- `mise run test:logged -- --name repository-tests -- mise run test` ran the backend with two workers alongside browser and other-worktree checks. `backs off failed reconciliation for 30 seconds and clears the floor after success` timed out at 5007.44 ms; `lets an explicit first prompt bypass rename retry backoff` subsequently observed one fake-Codex log entry instead of two (129.93 ms).
- Backend totals: 9909 passed, 60 skipped and three failed across 9972 tests in 576 files (968.42 s). The third failure was the Mermaid watchdog tracked in 0512. The repository command exited 1 after 1022.1 s.
- `mise run test:logged -- --name environment-create-owner -- bun test --cwd apps/backend ./tests/commands-registry-environments-create.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 13.7 s).
- Evidence: `orkestrator-test-run.NMPAwO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.EP6EVD/repository-tests.log.gz` under the host temporary directory. The second failure may have cascaded from the first timeout's unfinished work, but this is unproven. No assertion, deadline, or skip changed.


## Recurrence — 2026-10-24 (worktree signal review validation)

- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`; standard aggregate worker leases, with other checkout validation active on the host.
- **Failures:** `does not repeat name generation when an unreachable origin is ignored` (5008.83 ms), `lets an explicit first prompt bypass rename retry backoff` (5004.82 ms), and `does not throw when rename scheduling is refused during shutdown` (5001.93 ms), with follow-on fixture errors.
- **Owning-file rerun:** `mise run test:logged -- --name watcher-command-create-owner -- bun test --cwd <checkout>/apps/backend ./tests/commands-registry-environments-create.test.ts --parallel=1 --only-failures` passed unchanged in 25.4 seconds.
- **Evidence:** `orkestrator-test-run.iTzv5K/` under the host temporary directory; the full aggregate remains failed. None of these owning files was changed.
- **Final aggregate counts:** backend 10705 passed, 116 skipped, 20 failed and five between-test errors across 10841 tests (747.20 seconds). Fourteen failures were the unchanged OpenCode conformance expectation for CLI 1.19.0 versus the installed 1.19.4; the other six were the timing cases recorded here and in companion records. The complete repository run exited 1 after 1189.0 seconds, including time queued for shared worker capacity.
