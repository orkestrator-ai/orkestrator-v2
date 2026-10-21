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
