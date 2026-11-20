# Copy completion test's Bash fixture times out in the slow suite

- **ID:** 10009
- **Status:** open
- **Date observed:** 2026-11-20, macOS arm64, Bun 1.4.4.
- **Reviewed commit:** `8d3a72226b0c87a5bc32bb73ad068e784b982344`, base
  `e102a0dd55fc6360de61959c4ff843c9032cadfe`.
- **Test:** `verified copy helper > a missing listing completion times out as extract-failed`
  in `tests/unit/migrate-copy.test.ts:131`.
- **Original command:** `mise run test:logged -- --name slow-tests -- mise run test:slow`.
  Root and agent-support tests used one isolated Bun worker alongside the
  workspace and bridge groups.
- **Failure:** `spawnSync bash ETIMEDOUT` at the fixture's 5 s limit, before
  the assertion could read the script's completion status (5804.78 ms test
  duration). Root and agent-support reported 540 passed, one skipped and one
  failed across 33 files (625.21 s).
- **Complete owner rerun:** the aggregate runner's
  `bun test ./tests/unit/migrate-copy.test.ts --parallel=1` passed all 13 tests
  (1.7 s logged). The shell may have started slowly or waited on a child.
  The timeout alone does not establish which.
- **Evidence:** `orkestrator-test-run.B7Fj7m` in the host temporary directory,
  logs `root-and-agent-support-tests.log.gz` and
  `rerun-tests-unit-migrate-copy-test-ts.log.gz`. The status mismatch reported
  in [1140](../aggregate-validation-runs/1140-direct-history-cursors-0232-validation.md)
  occurred after the fixture returned and is a different symptom.
