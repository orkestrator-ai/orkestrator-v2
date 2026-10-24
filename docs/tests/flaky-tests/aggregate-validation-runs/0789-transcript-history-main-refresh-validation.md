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
