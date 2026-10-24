# Transcript-history main refresh validation

- **ID:** 0789
- **Status:** open
- **Date observed:** 2026-10-24
- **Merge parents:** `109a3a90509f3b5f258881f9004c4fde4747f0a9` and `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Common ancestor:** `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Original command:** `env -u PORT mise run test:logged -- --name merge-complete-suite -- mise run test`, with the testing guide's GNU-tool PATH and `ORKESTRATOR_TEST_AREA_BASE` set to the common ancestor.
- **Worker configuration:** default workspace/root/bridge/protocol reservations 4/1/2/1; backend used two workers. Transcript-artifact tests were selected. The unchanged tmux area was excluded by the normal import-graph selector.
- **Host:** macOS arm64, Bun 1.4.3, other worktrees validating concurrently. Observed load average 147.21 / 97.88 / 58.08 during the first isolated reruns.
- **Aggregate result:** exit 1 at the wrapper's 1,800-second absolute deadline. Bridges waited 922.7 seconds for capacity; workspace waited 1,455.1 seconds. The wrapper terminated the backend run before its final result. The aggregate remains failed and incomplete.
- **Passing checks:** format, lint (warnings), complete repository typecheck, Codex protocol lockfile, and the public-web, desktop, protocol, toolchain, renderer and CLI workspace packages. Cursor, Pi, Claude and ACP bridge packages passed.
- **Root/support:** 3,397 passed, three failed and one between-test error across 3,400 tests in 162 files (970.54 seconds). The failures were Pi supported-SDK staging (30006.86 ms), disk report (5015.10 ms, plus the between-test error) and the efficiency checkpoint workload (5012.23 ms).
- **Codex:** 2,346 passed, forty skipped and two failed across 2,388 tests in 88 files (109.27 seconds). Session-title process discovery failed at 1302.01 ms, and the fake app-server invocation test timed out at 5027.62 ms. Complete unchanged owners passed alone in 6.6 and 0.3 seconds; see [0472](../agent-bridges/0472-codex-title-helper-process-discovery.md) and [0210](../agent-bridges/0210-fake-codex-process-timeout.md).
- **Evidence:** outer `orkestrator-test-run.I7HssJ/merge-complete-suite.log.gz`; compressed copies of all four inner logs retained under `orkestrator-test-run.YFMbrr` in the host temporary directory. The inner aggregate was interrupted before normal finalization.

## Conflict resolution and validation scope

The complete original unmerged path list was captured as NUL-separated bytes before staging, retained with both merge-parent IDs under the worktree's local Git metadata (`merge-conflict-history/<ours>-<theirs>/original-unmerged-paths.z`). All five original conflicts remain in scope:

| Path under `docs/tests/flaky-tests/` | Resolution |
| --- | --- |
| `agent-bridges/0000-index.md` | Keep the concise Pi summary, add main's runtime-state recurrence, and retain both histories in the case. |
| `agent-bridges/0514-pi-bridge-vendor-timeout-under-load.md` | Retain both dated transcript-history and runtime-state validation sections. |
| `backend-services-and-tooling/0000-index.md` | Retain both branches' new case rows, including 0748 and 0787. |
| `environments-and-containers/0000-index.md` | Combine the firewall observations, retain branch-specific SSH/storage recurrences, main's refresh recurrence and new 0750 row, and the feature branch's 0786 row. |
| `environments-and-containers/0632-firewall-policy-probe-budget.md` | Retain both branches' distinct host-condition observations. |

The indexes are consumed by `tests/unit/flaky-tests-index.test.ts`. The common-ancestor-to-result delta also contains source, configuration and tests (267 paths before the new validation records), including clean auto-merges. Validation therefore covers the combined result and does not use a prose-only skip. No production source or test assertion was manually changed during this merge resolution.

## Root owning-file reruns

All commands used `env -u PORT`, the same GNU-tool PATH, `mise run test:logged`, an explicit test path, `--parallel=1` and `--only-failures`.

| Owner | Logged command name and result | Evidence |
| --- | --- | --- |
| `tests/unit/pi-bridge-vendor.test.ts` | `merge-pi-vendor-owner`: four passed, one failed; 30004.91 ms timeout, 35.0 s logged. This observation is not newly classified as flaky. | `orkestrator-test-run.4IZcDH/merge-pi-vendor-owner.log.gz` |
| `tests/unit/disk-report.test.ts` | `merge-disk-report-owner`: four passed, one failed and one error; 5048.67 ms timeout, 7.2 s logged. After root completion, `merge-disk-report-owner-after-root` still failed (5026.99 ms; 7.4 s logged). Neither observation is newly classified as flaky. | `orkestrator-test-run.RbKxCm/merge-disk-report-owner.log.gz`; `orkestrator-test-run.zJwgTn/merge-disk-report-owner-after-root.log.gz` |
| `tests/unit/efficiency/harness.test.ts` | `merge-efficiency-owner`: 32 passed, one failed (5001.79 ms; 14.8 s logged). `merge-efficiency-owner-after-root` passed the complete unchanged owner in 7.2 s. Confirmed intermittence; see [0788](../backend-services-and-tooling/0788-efficiency-checkpoint-aggregate-timeout.md). | `orkestrator-test-run.UI9utn/merge-efficiency-owner.log.gz`; successful output removed by the runner |

No implementation, assertion, deadline or skip changed to obtain these results. Shared-host contention is a possible contributor, not an established root cause. The original aggregate exit remains failed.

## Backend completion

`env -u PORT ORKESTRATOR_BACKEND_TEST_WORKERS=2 ORKESTRATOR_BACKEND_TEST_IGNORE='--path-ignore-patterns=tests/tmux*.test.ts --path-ignore-patterns=src/core/tmux*.test.ts' mise run test:logged -- --name merge-backend-suite -- bun run --cwd apps/backend test:workspace`, with the same GNU-tool PATH, completed the backend package using the same workers and area selection as the interrupted aggregate. It reported 10,531 passed, 115 skipped and fourteen failed across 10,660 tests in 626 files (365.02 seconds; exit 1). Every failure was an OpenCode execution-policy version assertion expecting `1.19.0` while the host CLI returned `1.19.4`.

The complete unchanged owner, `env -u PORT mise run test:logged -- --name merge-execution-policy-owner -- bun test --cwd apps/backend ./src/core/conformance-execution-policy.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`, reproduced the same fourteen failures with 56 passes (3.8 seconds logged). This file is identical between the merge parents. The same mismatch was already recorded in [0740](0740-agent-accounts-sign-in-0003-validation.md); it is not newly classified as flaky.

Evidence: `orkestrator-test-run.TTqEo3/merge-backend-suite.log.gz` and `orkestrator-test-run.EGZKtC/merge-execution-policy-owner.log.gz` under the host temporary directory.

The flaky-register consistency owner passed after merging the indexes and adding these records. Conflict-marker and local-link checks passed. Browser, Electron, Docker and CLI scenario suites were not repeated in this merge-resolution run; the package suites above are the completed coverage. The full aggregate remains non-green, including its wrapper timeout and the persistent Pi/disk-report and OpenCode limitations.


## Refresh through main `95c9cb46` — 2026-10-24

Merge parents: `3202f66c083931b4c67a9e74d2d9ae356957d6e9` and `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`; common ancestor `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`. Before staging, the complete five-path original conflict list and both parents were retained in local Git metadata under `merge-conflict-history/<ours>-<theirs>/original-unmerged-paths.z`.

The conflicting aggregate index, diagnostic-bounds case 0043, backend/tooling index and environments index retain both branches' records. The backend index also removes duplicate rows for the same case file introduced by the auto-merge. Todo 0050 keeps the feature branch's completed work and incorporates main's newer 0034 support-window decision: both older-bridge history paths are eligible for retirement, with in-process paging qualification still needed before removing joined sync-v1. Both occurrences of the earlier decision were reconciled. No production source or test assertion was manually changed.

The complete common-ancestor-to-result delta contains 288 paths, including source, configuration, tests and clean auto-merges; the conflicting indexes are consumed by the registry consistency test. Validation therefore covers the integrated tree, including the automatically merged phase metrics and compatibility-use counter in `native-agent-transcript-projection.ts`.

- **Static checks:** `mise run format:check`, `mise run lint` (warnings retained in local merge metadata), and `env -u PORT mise run test:logged -- --name main-refresh-types -- mise run typecheck` passed (typecheck: 13.8 s).
- **Registry:** `env -u PORT mise run test:logged -- --name main-refresh-registry -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` passed (0.4 s).
- **Default suite:** `env -u PORT ORKESTRATOR_TEST_AREA_BASE=d6ed0717d00a9a04ba658ba6c50e0978bc2011a6 mise run test:logged -- --name main-refresh-tests -- mise run test`, with the testing guide's GNU-tool PATH. All four groups started without waiting; workspace/root/bridge/protocol reservations were 4/1/2/1. Both transcript-artifact and tmux areas were selected. All bridge packages and the protocol lockfile passed. Root/support reported 3,398 passed and one failed across 3,399 tests in 162 files (260.67 s). Every workspace package passed; backend reported 10,833 passed, 116 skipped and zero failures. The workspace group completed in 690.8 s. The aggregate exited 1 after 691.3 s solely because of the root firewall timeout; all groups completed.
- **Root failure:** `container firewall policy > firewall uses stored domains and tolerates a repeated GitHub bootstrap range` exceeded its five-second budget (5020.35 ms).
- **Complete unchanged owner:** `env -u PORT mise run test:logged -- --name main-refresh-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`, same GNU-tool PATH, retained seven five-second failures (seventeen passed; 60.0 s logged). Failures covered stored domains, policy-2 host ports, four policy-3 probe variants and GitHub seed/live/cache fallback. This observation is not newly classified as flaky. Neither `tests/unit/firewall-policy.test.ts` nor `docker/firewall-domains.sh` differs between the merge parents.
- **Browser:** `bunx playwright test --config e2e/playwright.config.ts e2e/OpenCodePipelineTranscript.spec.ts --workers=2`, through `test:logged` as `main-refresh-pipeline-browser` with a fresh unused fixture port, passed (10.7 s).
- **Image:** `mise run test:logged -- --name main-refresh-image -- mise run docker:build:dev --profile merge-main-refresh` passed (54.4 s), building the checkout's isolated `orkestrator-v2:dev-fa9e65688899` image.
- **Real Docker:** `env -u PORT ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE=orkestrator-v2:dev-fa9e65688899 mise run test:logged -- --name main-refresh-container-signal -- bun test --cwd apps/backend ./tests/container-worktree-signal-docker.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (22.2 s). The watcher armed, invalidated lockfile and source changes, ignored excluded paths, replaced a lineage without duplication, and demoted to timer fallback on watcher death. The fixture removed its container and temporary state; an image-filtered Docker listing confirmed no remaining container. No app profile was launched; the isolated image remains as build cache.
- **Evidence:** outer `orkestrator-test-run.RFyuG4/main-refresh-tests.log.gz`; inner `orkestrator-test-run.uF8rZ0/` logs after finalization; owner `orkestrator-test-run.BYMkVs/main-refresh-firewall-owner.log.gz`, all under the host temporary directory. Passing command output is removed by the runner.

The original aggregate remains non-green. No assertion, timeout or skip was changed to obtain these results; no new cause for the firewall deadlines was established. Live provider, Electron and broad application scenario suites were not repeated in this refresh; the focused browser and real-container checks above cover the directly affected scenarios.


## Refresh through main `a566e47cb` — 2026-10-24

- **Merge parents:** `4374b013e0e768f0bdd25248cbc7dd69ce3c9468` and `a566e47cb3bd08b8180caa64578cb599c4563017`; common ancestor `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Conflict capture:** all eight original paths were retained before staging as NUL-separated bytes in local Git metadata, alongside both parents. Conflicts were the agent-bridge index and cases 0210/0472, aggregate index and case 0043, environment index and case 0192, and the transcript todo index. Both branches' distinct observations remain. Case 0043 keeps its explicit historical-resolution/reopening note. The todo index retains completed 0050 work, follow-up 0090, main's new 0082 item, and unique sequential ranks; 0050 also reflects the already-decided support window and remaining retirement work.
- **Combined scope:** 297 paths from the common ancestor to the resolved tree, including source, configuration, protocol/package metadata and clean auto-merges. Conflicting indexes are consumed by the flake-registry test, so this is not a prose-only validation skip. No production source or test assertion was manually changed during resolution.
- **Static checks:** formatting, lint (warnings), and complete repository typechecking passed. Typecheck command: `env -u PORT mise run test:logged -- --name main-a566-types -- mise run typecheck` (9.7 s).
- **Registry:** `env -u PORT mise run test:logged -- --name main-a566-registry -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` passed (0.2 s).
- **Default suite:** `env -u PORT ORKESTRATOR_TEST_AREA_BASE=95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d mise run test:logged -- --name main-a566-tests -- mise run test`, with the testing guide's GNU-tool PATH. Both area suites were selected by the CLI tsconfig and protocol package metadata changes. Workspace/root/bridge/protocol reservations were 4/1/2/1, and all groups started immediately. Root/support passed 3,399 tests in 162 files (180.45 s); all bridge packages and the protocol lockfile passed. All workspace packages also passed, and the complete default suite exited 0 in 527.2 s. Passing output was removed by the runner.
- **Credential-free CLI:** `env -u PORT mise run test:logged -- --name main-a566-cli -- mise run test:cli:scenarios` passed (49.2 s), including owned scenario cleanup.
- **Focused browser:** `bunx playwright test --config e2e/playwright.config.ts e2e/DesignLaunchDialog.spec.ts e2e/AnnotationDestinationLayout.spec.ts --workers=2`, through `test:logged` as `main-a566-browser`, with a fresh unused fixture port, passed (8.3 s).
- **Electron annotation owner:** `env -u PORT ORKESTRATOR_AGENT_TEST_RUN_ID=main-a566-annotations mise run test:logged -- --name main-a566-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/web-annotations-electron.spec.ts --workers=1` failed at `the real Notes column shrinks the native view, overlays hide it, and the narrow switch swaps surfaces` (line 1372). The Notes button's `toBeFocused` assertion at line 1368 received inactive after five seconds. Six passed, one failed, three serial successors did not run (29.4 s logged).
- **Electron owner rerun:** the same complete file, `ORKESTRATOR_AGENT_TEST_RUN_ID=main-a566-annotations-alone`, logged as `main-a566-electron-alone`, repeated the same focus failure after this run's first design profile had closed (six passed, one failed, three did not run; 25.3 s). It is not newly classified as flaky; no root cause is established. The owner teardown closed Electron, stopped its fixture and Vite, removed temporary state, and confirmed no Codex prompt/session launch. Evidence: `orkestrator-test-run.57XR5i/main-a566-electron.log.gz` and `orkestrator-test-run.jWWV8c/main-a566-electron-alone.log.gz`, plus each named run's artifacts under `output/agent-testing/`.
- **Isolated design:** first run failed at the guided brief's visibility assertion, plus the oversized-trace sanitization error; the complete unchanged owner on a fresh profile passed both cases in 36.7 s. The first result remains failed; detailed commands, separate failure-point evidence and artifact paths are in [0380](../design-canvas-and-artifacts/0380-design-text-fallback-pane-persistence.md). Both owned design profiles were stopped/reset; their state directories and the oversized unsanitized trace are gone.
- **Core evidence:** the authoritative `main-a566-tests` result was PASS (exit 0, 527.2 s). The runner removed successful output, including its temporary outer/inner run directories; outcomes are also retained beside the original conflict capture in local Git metadata.

The Electron owner remains non-green, including its three unexecuted serial successors. Live-provider, iOS and unrelated platform qualification were not enabled. No assertion, timeout, skip or implementation was changed to produce a passing result.
