# OpenCode probe cleanup observes another temporary root

- **ID:** 0242
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `runOpenCodeLiveCompatibility > a deadline while the CLI version is read leaves nothing to create later`
- **Owning file:** `scripts/opencode-live-compatibility-probe.test.ts:432`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
  on `vh-multireview-fence-checks-14f5158f73c9`, merging `origin/main` at
  `d087e44f` into `acb1807e`.
- **Worker configuration:** four workspace slots (two package tasks with two
  Bun workers each), one root slot, two bridge slots and one protocol slot.
  Other worktrees were also validating on the host.
- **Failure:** Expected the temporary-root list to remain empty; observed one `ork-opencode-compat-*` directory after the deadline (72.32 ms). The spawned-server count assertion passed.
- **Suite counts:** Root: 2,978 passed, 1 skipped, 1 failed across 137 files (172.21 s). The full run exited 1 after 344.9 s;
  backend had two failures and root had one. Bridges and protocol passed.
- **Isolated owning-file rerun:** `mise run test:logged -- --name merge-probe-rerun -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (0.5 s).
- **Evidence:** `/tmp/orkestrator-test-run.ZdmgHl/root-and-agent-support-tests.log.gz`;
  aggregate summary at `/tmp/orkestrator-test-run.Dt7ssz/summary.json`.
- **Hypothesis:** Other worktrees were running the same suite on this host. The test compares a process-wide temporary-directory prefix, so another run may create a root between snapshots. Attribution is unproven; the deadline/server-exit symptom in case 0166 is tracked separately.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
