# Chromium executable-document policy hook timeout

- **ID:** 0507
- **Status:** open
- **Date observed:** 2026-10-20
- **Test:** `executable document policy in chromium > (unnamed)` (hook timeout)
- **Owner:** `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts`

## Main merge validation

- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-full-tests -- mise run test`.
- **Configuration:** aggregate workspace/root/bridges/protocol groups reserved 4/1/2/1 worker slots; browser, Electron and Docker scenario validation also ran during this aggregate.
- **Failure:** the backend reported `(fail) executable document policy in chromium > (unnamed) [5002.53ms]` and `a beforeEach/afterEach hook timed out for this test`, after reporting one dangling process killed.
- **Aggregate counts:** backend 9,573 passed, 41 skipped and two failed across 533 files (539.09 seconds); aggregate exit 1 in 579.8 seconds. The other failure was shared-fixture schema contamination (0508); root, bridges, protocol and the other workspace packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-artifact-engines-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures`.
- **Isolated result:** the complete unchanged owning file passed, exit 0 in 250.3 seconds, with no assertion, timeout or skip changes.
- **Evidence:** `orkestrator-test-run.le6gpX/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the passing logged runner retains its summary in `orkestrator-test-run.xGD2SX/summary.json`.
- **Assessment:** confirmed intermittent hook failure. Browser startup or shutdown contention is plausible; the report does not identify which hook failed, and the cause remains unproven. This differs from the dropped-click assertions resolved in 0505.

## Container account marker validation recurrence — 2026-10-21

- **Original command:** `mise run test:logged -- --name account-containers -- bun run --cwd apps/backend test ./src/core/agent-accounts-containers.test.ts`.
- **Configuration:** the package script expands to `bun test --preload ../../tests/setup-node.ts src tests --parallel ./src/core/agent-accounts-containers.test.ts`; its existing `src tests` arguments selected the whole backend suite, with default parallelism. Other aggregate and browser validation was running on the host.
- **Failure:** the same unnamed Chromium hook timed out after 5005.58 ms. Backend totals were 9,807 passed, 67 skipped and one failed across 552 files, in 138.49 seconds. Credential account tests passed.
- **Owning-file rerun:** `mise run test:logged -- --name artifact-engine-isolated -- bun test --cwd apps/backend ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures`.
- **Isolated result:** unchanged owning file passed, exit 0 in 88.0 seconds. No assertions, deadlines or skips changed.
- **Evidence:** `orkestrator-test-run.JvGFao/account-containers.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the existing intermittent hook timeout under concurrent validation; resource contention remains a hypothesis, not an established cause. Focused backend runs must use `bun test --cwd apps/backend ./path.test.ts --parallel=1` directly rather than append a path to the package's whole-suite script.

## Tool-fold coverage validation recurrence — 2026-10-23

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` on `animate-tool-calls-9f849713d495-r1`.
- **Worker configuration:** Workspace/root/bridges/protocol groups reserved 4/1/2/1 worker slots; the backend used two isolated Bun workers. Other worktree validation and transcript browser checks shared the host.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.5bWdNz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** The unnamed Chromium policy hook timed out after 5003.96 ms, with one dangling process reported killed.
- **Owning-file rerun:** `mise run test:logged -- --name artifact-engines-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 59.8 seconds.
- **Assessment:** Recurrence of the existing intermittent hook timeout. Host contention remains an unproven explanation; assertions, deadlines and skips were unchanged.
- **Aggregate counts:** Backend 10,076 passed, 86 skipped and two failed across 585 files (650.46 seconds); the aggregate exited 1 after 959.6 seconds. The web suite passed 8,824 tests with 10 skips. The initial root group also caught an unsafe DOM absence assertion in the newly added unit coverage; that assertion was corrected, and its owning diagnostics guard passed separately. Bridges, protocol regeneration and all remaining workspace packages passed.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The Chromium policy hook timed out after 5001.89 ms. `mise run test:logged -- --name merge-artifact-engine-owner -- bun --cwd=apps/backend test ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (122.9 s); unavailable Firefox/WebKit coverage remained skipped.

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Repository separator validation — 2026-10-25

- **Change:** `146fff6c6` on `repo-group-separators-4be2bb2ba0a0-r1`; sidebar rendering and regression tests only.
- **Original command:** `mise run test:logged -- --name aggregate-tests -- mise run test`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers. Component-browser and isolated-browser checks also ran on the host.
- **Failure:** The unnamed Chromium executable-document policy hook timed out after 5001.40 ms; the runner reported one dangling process killed.
- **Owning-file rerun:** `mise run test:logged -- --name artifact-engine-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 98.9 seconds logged.
- **Aggregate counts:** Backend 11,012 passed, 79 skipped and three failed across 660 files (642.56 s); root/support 3,405 passed and one failed across 162 files (403.31 s). All other workspace packages, bridges and protocol passed; aggregate exit 1 in 692.6 s logged.
- **Evidence:** `orkestrator-test-run.sQR1xm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the outer aggregate log is `orkestrator-test-run.k2y50g/aggregate-tests.log.gz`.
- **Assessment:** Recurrence of the existing intermittent failure. No backend implementation, assertion, deadline or skip changed; the original aggregate remains non-green.
