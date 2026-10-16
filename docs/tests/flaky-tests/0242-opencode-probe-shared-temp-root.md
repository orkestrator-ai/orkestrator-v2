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


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers, root used one. Root admission
  waited 114.7 seconds and bridges waited 394.0 seconds on the shared host.
- **Suite counts:** root 2,996 passed, one skipped and three failed across
  3,000 tests in 137 files (368.64 seconds execution). Backend reported
  8,380 passed, 40 skipped and ten failed. Other workspace packages, bridges
  and protocol verification passed; aggregate exited 1 after 671.2 seconds.
- **Failure:** `kills the server when the overall deadline expires` observed a temporary root instead of `[]` (61.45 ms, line 399); `a deadline during setup stops the abandoned probe from spawning a server` observed `[]` instead of its initial root list (204.66 ms, line 422). Their server-exit and no-spawn assertions passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-probe-owner -- bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the unchanged owning file (exit 0,
  0.4 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/root-and-agent-support-tests.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. The
  existing contention hypothesis remains unconfirmed; no implementation,
  assertion, timeout or skip changed.
