# Project landing-tab review validation

- **ID:** 1248
- **Status:** open
- **Date observed:** 2026-10-28
- **Branch:** `project-landing-tab-by-grouping-2ec2f8d6ed30`
- **Implementation commit:** `13ef828cb`
- **Original command:** `mise run test:logged -- --name review-unit-rerun -- mise run test`
- **Workers:** default concurrent workspace/root/bridges/protocol groups, reserving
  6/1/2/1 slots after about 70 seconds of host admission wait.
- **Result:** exit 1 after 780.0 seconds. Root: 3,240 pass, one fail. Web:
  10,206 pass, 10 skip, three fail. Backend: 9,982 pass, 87 skip, three fail.
  Bridges and protocol passed. Host load subsequently measured 113/100/73.
- **Artifacts:** `orkestrator-test-run.KcD1Q7` (outer runner),
  `orkestrator-test-run.kVqhIv` (group logs), under the host temporary directory.

The aggregate began before the realm effect-replay repair was complete. Its
new `RemoteWorkspaceRegion` regression observed the original missing
`boardTab` (263 ms), while subsequent complete-owner runs and the real Electron
scenario passed. This overlapping-edit result is not classified as a flake;
a fresh `mise run test` was started after the implementation commit.

| Unchanged owner | Aggregate observation | Complete-owner rerun |
| --- | --- | --- |
| `tests/unit/components/GlobalSettings.test.tsx` | `copies the gateway token` could not find its control (156.53 ms). | `mise run test:logged -- --name rerun-global-settings -- bun test ./tests/unit/components/GlobalSettings.test.tsx --parallel=1 --only-failures` passed (16.7 s). |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | Concurrent hook counter read `working 14 0`, expected `working 20 0` (1,335.19 ms); recurrence of [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md). | `mise run test:logged -- --name isolated-hook-counters -- bun --cwd=apps/backend test ./tests/claude-state-signal-integration.test.ts --parallel=1 --only-failures` passed (3.7 s). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Maximal-list filtering counted two projection reads, expected one (2,190.57 ms); recurrence of [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). | `mise run test:logged -- --name isolated-native-commands -- bun --cwd=apps/web test ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures` repeated the mismatch: 21 pass, one fail (12.1 s). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Over-limit root-change approval timed out at 5,484.61 ms; also observed in [1247](1247-pending-rename-recovery-validation.md). | `mise run test:logged -- --name isolated-node-actions -- bun --cwd=apps/web test ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures` repeated the timeout: 10 pass, one fail (9.2 s), artifact `orkestrator-test-run.xQVi1P`. |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `name the store they write` timed out at 5,297.47 ms; also observed in [1247](1247-pending-rename-recovery-validation.md). | `mise run test:logged -- --name isolated-storage-guards -- bun --cwd=apps/backend test ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures` repeated the timeout: 35 pass, one fail (12.3 s), artifact `orkestrator-test-run.SMgAkQ`. |
| `apps/backend/src/core/looped-review-scheduling.test.ts` | Persisted-fixture transitions timed out at 5,003.21 ms; recurrence of [0189](../coordinator-and-multi-review/0189-looped-review-scheduling-timeout.md). | `mise run test:logged -- --name isolated-looped-scheduling -- bun --cwd=apps/backend test ./src/core/looped-review-scheduling.test.ts --parallel=1 --only-failures` repeated the timeout: six pass, one fail, one SQLite I/O error after timeout cleanup (12.5 s), artifact `orkestrator-test-run.TbGaWr`. |

These unrelated owners, assertions, timeouts and skips were not changed. Only
the two owners that passed alone establish intermittent failures for this run;
the other isolated failures remain non-green.

## Electron and focused qualification

The focused realm command passed in 106.1 s:

```sh
mise run test:logged -- --name workspace-realm-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts workspace-realm-electron.spec.ts
```

The required full rerun,
`ORKESTRATOR_AGENT_TEST_RUN_ID=landing-tabs-review mise run test:logged -- --name agent-electron -- mise run test:agent:electron`,
finished with 33 passed, four failed, one skipped and six not run (17.2 min).
The workspace-realm scenario passed again (76.9 s), including both grouping
policies, route upgrade and workspace isolation. The failures were design-canvas
process cleanup, native nickname refresh, Vite HMR after a hidden/reloaded tab,
and annotation capture pixels. These other owners were not modified or
classified as flakes from this run. Evidence:
`orkestrator-test-run.9eDgcl/agent-electron.log.gz` and
`output/agent-testing/landing-tabs-review/electron/results.json`.

The landing-tab component tests were subsequently moved into
`project-landing.test.tsx` in commit `f6c43b287`, keeping the older federation UI
suite below 2,000 lines. The complete two-file focused run passed (19.8 s);
web typechecking and focused lint passed after the move. The separate realm
region owner passed (3.7 s), and the Electron test configuration typecheck
passed (1.0 s). Existing preparation format, lint and full typechecks had passed;
changed source files also passed focused formatting, lint and typechecks.

## Final default-suite and browser reruns

`mise run test:logged -- --name review-unit-final -- mise run test` ran the final
source after about 544 seconds of host admission wait and finished in 1,000.3 s.
The full web package passed (10,209 pass, 10 skip, no failures across 648 files),
as did the backend (9,985 pass, 87 skip, no failures). All landing-tab tests,
including the effect-replay regression and split test file, passed in this run.
The overall command exited 1: desktop backend exit-deadline handling failed;
root disk-report and private-origin handoff-cleanup cases failed (3,239 pass,
two fail, one between-test error); and the fake Codex app-server version test
timed out. These other owners were unchanged and were not classified as flakes
from this final run. Artifacts: `orkestrator-test-run.cHb4tO` (outer runner) and
`orkestrator-test-run.RMz8V0` (group logs).

The exact `mise run test:browser` rerun first refused port 1422 because its
fixture server belonged to another checkout (artifact `orkestrator-test-run.k9PZhc`).
Rerunning the same command with `ORKESTRATOR_E2E_PORT=57952` and
`ORKESTRATOR_PUBLIC_E2E_PORT=57953` completed the component suite with 837 passed,
44 failed and 105 skipped (22.6 min, nine workers). Many failures were navigation
or control timeouts under shared-host load; the native branch picker also
repeated preparation's failure. The public-site command after `&&` did not run.
No unrelated browser assertions, timeouts or skips changed. The log is
`orkestrator-test-run.a80wZm/review-browser-rerun.log.gz`. Only complete-owner
rerun results can establish flakes; the aggregate alone does not.

The affected sidebar browser owners then passed completely (63.7 s):

```sh
ORKESTRATOR_E2E_PORT=57952 mise run test:logged -- --name landing-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/MergedProjectList.spec.ts e2e/RemoteMachineTree.spec.ts --workers=1
```

This includes the truncated-summary scenario that timed out during aggregate
navigation. No browser test assertion or timeout was changed. A final process
check found no Electron main or backend test process referencing this checkout;
the isolated Electron profiles were handled by their test cleanup routines.
