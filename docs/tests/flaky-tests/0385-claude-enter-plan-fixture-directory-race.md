# Claude EnterPlanMode failure fixture already has a directory

- **ID:** 0385
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `plan approval flow > denies EnterPlanMode when its durable preference cannot be written`
- **File:** `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:827`
- **Original command:** `mise run test:logged -- --name main-refresh-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` at `83b78c97` into `5a48bf31`.
- **Workers:** aggregate workspace/root/bridge/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package on the shared macOS host.
- **Failure:** the fixture's `writeFile` of `.claude` failed with `EISDIR` after 1.24 ms, before invoking `EnterPlanMode` or asserting the denial.
- **Package counts:** Claude reported 1563 passed, five skipped and one failed across 1569 tests in 74 files (40.21 seconds). Every other bridge package passed.
- **Owning-file rerun:** `mise run test:logged -- --name main-refresh-claude-interactions -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.2 seconds.
- **Evidence:** `orkestrator-test-run.BPKKpo/bridges.log.gz` below the platform temporary directory after aggregate completion.
- **Assessment:** the unchanged isolated pass establishes intermittence. Asynchronous session setup may create the directory before the fixture replaces it with a file; this remains a hypothesis. No implementation, assertion, timeout or skip changed.

- **Bridge-group rerun:** `ORKESTRATOR_TEST_WORKERS=1 mise run test:logged -- --name main-refresh-bridges -- bunx turbo run test:bridge --concurrency=2 --continue=dependencies-successful --output-logs=new-only --log-order=stream` passed every bridge package unchanged, exit 0, in 88.1 seconds.

## CLI matrices second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, macOS arm64, Bun 1.4.3, workspace/root/bridges/protocol reservations 4/1/2/1; component and isolated browser validation ran concurrently.
- **Failure:** the sibling `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted` case failed in the same fixture write (`session-manager-interactions.test.ts:863`): `.claude` was already a directory (`EISDIR`, 2.06 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-claude-interactions-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged (0.8 seconds logged).
- **Evidence:** `orkestrator-test-run.0J1rem/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** an intermittent recurrence of the fixture-directory symptom in the exit-plan case; asynchronous session setup remains a hypothesis. No implementation, assertion, timeout or skip changed.

Claude package counts: 1563 passed, five skipped and one failed across 1569 tests in 74 files (70.94 seconds). The other four bridge packages passed.

Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

## Coordinator qualification main refresh — 2026-10-18

- **Original command:** `mise run test:logged -- --name refresh-full -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` into pre-merge HEAD `1bca78a2`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside credential-free CLI scenarios and isolated design-browser validation.
- **Related owner:** `status frames > a failed plan-mode persistence write keeps the current toggle`, `bridges/claude-bridge/src/services/session-manager-system-events.test.ts:270`.
- **Failure:** `.claude` was already a directory when the fixture tried to replace it with a file (`EISDIR`, 2.09 ms), before the assertion on the plan-mode toggle.
- **Owning-file rerun:** `mise run test:logged -- --name refresh-claude-system-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.2 seconds.
- **Evidence:** `orkestrator-test-run.Bda6du/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** the unchanged isolated pass confirms intermittence in the same fixture-directory pattern. Asynchronous session setup remains a hypothesis; no source, assertion, timeout or skip changed.

The aggregate finished in 419.7 seconds with only the bridge group failing. Claude reported 1575 passed, five skipped and one failed across 1581 tests in 74 files (39.22 seconds); all other bridges, every workspace package, root/support and protocol regeneration passed.

The subsequent warm run, `mise run test:logged -- --name refresh-full-warm -- mise run test`, passed all four groups unchanged (exit 0, 322.1 seconds logged). The isolated design-browser task and credential-free CLI scenario matrix also passed; no test skip, assertion or timeout changed.

## Keep-open picker main merge — 2026-10-19

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` at `d28f0d63` into `24d4ac1c`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside browser validation.
- **Failure:** `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted` failed before its assertion because writing `.claude` raised `EISDIR` (`session-manager-interactions.test.ts:863`, 2.29 ms). Claude reported 1575 passed, five skipped and one failed across 1581 tests in 74 files (57.86 seconds); the other four bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-claude-interactions-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.1 seconds logged.
- **Evidence:** `orkestrator-test-run.4pe57b/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence of the existing fixture-directory symptom. No bridge implementation, assertion, timeout or skip changed.

The subsequent installed-dependency aggregate, `mise run test:logged -- --name merge-tests-installed -- mise run test`, passed all four groups unchanged (exit 0, 266.7 seconds logged).

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Queued-steer main merge validation — 2026-10-19

The recurrence, owning-file results and remaining limitations are recorded in
[0501](0501-queued-steer-main-merge-validation.md). No owning implementation,
assertion, timeout or skip was changed for validation.

## Rich transcripts workflow artifacts — 2026-10-20

- **Original command:** `mise run test` on branch `20261020-005611-6ba26bffea80` (uncommitted rich-transcripts work, base `67a6cc31`), macOS arm64, Bun 1.4.3.
- **Failure:** `plan approval flow > denies EnterPlanMode when its durable preference cannot be written` failed at the fixture `writeFile` (`session-manager-interactions.test.ts:827`) with `EISDIR` after 1.30 ms; the only failure of the run (codex lockfile, root/support and workspace groups passed).
- **Owning-file rerun:** `bun test src/services/session-manager-interactions.test.ts -t "denies EnterPlanMode when its durable preference"` from `bridges/claude-bridge` passed three times, and the whole file passed 29/29.
- **Assessment:** the same fixture-directory symptom. The branch's Claude bridge changes (artifact MCP server configuration, tool naming, permissions) add no file writes under the Claude home; no source, assertion, timeout or skip changed.

## Observation — 2026-10-20 (HTTP dispatch-detail review fixes)

- **Original command:** `mise run test:logged -- --name full-tests-gnu -- mise run test`,
  using the testing guide's GNU-tool PATH; workspace/root/bridges/protocol
  reserved 4/1/2/1 worker slots.
- **Failure:** `plan approval flow > denies EnterPlanMode when its durable preference cannot be written`
  failed at the fixture's `.claude` write with `EISDIR` (2.74 ms).
- **Package counts:** Claude reported 1,581 passed, five skipped and one failed
  across 1,587 tests in 74 files (47.65 seconds).
- **Owning-file reruns:** `mise run test:logged -- --name claude-interactions-isolated -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures`
  reproduced `EISDIR` in the sibling approved-exit persistence fixture
  (28 passed, one failed; 0.2 seconds). Repeating with the GNU-tool PATH and
  log name `claude-interactions-gnu-isolated` reproduced the original
  EnterPlanMode fixture failure (28 passed, one failed; 0.2 seconds).
- **Evidence:** `orkestrator-test-run.bOXAnB/bridges.log.gz`,
  `orkestrator-test-run.Q1KuIs/claude-interactions-isolated.log.gz` and
  `orkestrator-test-run.MhuXhW/claude-interactions-gnu-isolated.log.gz`.
- **Assessment:** the same previously tracked fixture-directory symptom;
  these isolated reruns did not pass, so this observation alone does not
  establish intermittence. The first aggregate in this review-fix validation
  passed all bridge packages unchanged. No bridge source, test assertion,
  timeout or skip changed.
- **Aggregate result:** the GNU-tool rerun finished in 636.6 seconds with only
  the bridge group failing. Every workspace package passed (backend: 9,530
  passed, 79 skipped, zero failed across 532 files); root/support and Codex
  protocol regeneration also passed.

## File/LOC change-tracking main merge — 2026-10-20

- **Original command:** `mise run test:logged -- --name merge-tests-final -- mise run test`, on `implement-file-change-f3950a40ac3a-r1`, merging `origin/main` (`6bc55812`) into `68cefe21`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; Bun 1.4.3 on macOS arm64.
- **Failure:** `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted` failed at `session-manager-interactions.test.ts:863` while writing its `.claude` sentinel: `EISDIR` (1.54 ms). Claude reported 1,600 passed, five skipped and one failed across 76 files (38.28 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name merge-claude-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.1 seconds).
- **Evidence:** `orkestrator-test-run.R5TGEu/bridges.log.gz` below the host temporary directory; the owning-file passing output was deleted by the logged runner.
- **Assessment:** confirmed recurrence of the existing fixture-directory race. The first full aggregate in this merge passed all bridge packages. No Claude source, assertions, deadlines or skips changed; concurrent fixture work remains a hypothesis.
- **Bridge-group rerun:** `mise run test:logged -- --name merge-bridges-rerun -- bunx turbo run test:bridge --cwd . '--filter=./bridges/*' --concurrency=2 --continue=dependencies-successful --output-logs=new-only --log-order=stream` passed all five unchanged bridge packages (exit 0, 77.5 seconds).
- **Final aggregate result:** exit 1 in 370.1 seconds, with only the bridge fixture above failing. All workspace packages, root/support and Codex protocol generation passed. Formatting, lint, typechecking, the application build, isolated browser suite, Electron suite and Docker suite also passed. Disposable browser and Docker profiles were stopped and reset. iOS and standalone CLI scenarios were omitted because the merge does not change those areas; ordinary CLI tests ran in the workspace suite.

## Sidebar collapse/layout review — 2026-10-22

- `mise run test:logged -- --name all-tests-corrected -- mise run test`
  passed the workspace, root/support and protocol groups. The bridge group
  failed only `denies EnterPlanMode when its durable preference cannot be written`:
  `.claude` was already a directory at line 827 (`EISDIR`, 2.90 ms).
  Total logged time: 407.7 seconds.
- The complete unchanged owner passed with the aggregate's Node preload:
  `mise run test:logged -- --name claude-interactions-node-rerun -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures`
  (exit 0, 0.1 seconds). An earlier direct owning-file rerun also passed.
- Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.X1qkBV/all-tests-corrected.log.gz`.
- This change does not alter bridge code or its fixtures. No assertion, timeout
  or skip was weakened; the aggregate exit remains failed.

## Machines settings main merge — 2026-10-22

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name latest-tests -- mise run test`, merging `7e051d955` into `814afe472`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; Claude used one isolated worker alongside browser validation.
- **Failure:** `denies EnterPlanMode when its durable preference cannot be written` hit `EISDIR` writing the fixture's `.claude` at line 827 (1.50 ms), before invoking the intended tool path.
- **Complete unchanged owner:** `mise run test:logged -- --name latest-claude-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed, exit 0 in 0.2 s.
- **Aggregate result:** workspace, root/support and protocol passed; the bridge group failed only this case. Claude reported 1602 passed, five skipped and one failed across 76 files (39.04 s). The complete aggregate exited 1 in 481.2 s.
- **Evidence:** `orkestrator-test-run.Eapjgt/bridges.log.gz` and outer `orkestrator-test-run.l1ORHc/latest-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent fixture recurrence. No implementation, assertion, timeout or skip changed.
