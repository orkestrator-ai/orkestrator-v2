# Build pipeline agent settings: preload hook timed out in the aggregate run

- **ID:** 10010
- **Status:** open
- **Date observed:** 2026-11-23
- **Base:** `307d19317`.
- **Observed branch:** `upgrade-packages-0a3b6266bb77-r1`, a dependency-upgrade batch that does not touch this file or the preloads (`tests/register-dom.ts`, `tests/setup.ts`).
- **File:** `apps/web/src/lib/build-pipeline-agent.test.ts`
- **Test:** `(unnamed)`: Bun reported `a beforeEach/afterEach hook timed out for this test` after 5,001.84 ms. The file declares no hooks of its own, so the hook is one of the `apps/web` preloads named in `apps/web/bunfig.toml`.
- **Original command:** `mise run test:logged -- --name full-suite-2 -- mise run test`. Other worktrees held test slots at the same time; the runner queued its reruns behind them.
- **Suite counts:** The web package reported 16,055 passed, 10 skipped and 1 failed across 1,146 files.
- **Load evidence:** In the same window the backend group logged `[storage] operation.slow ... commitMs=5020`, a SQLite commit that alone took five seconds, which points at host-wide I/O pressure rather than this file.
- **Isolated rerun:** The aggregate runner reran the file alone (`PASSED ALONE`, 5.7 s); it passed 14 of 14 tests.
- **Aggregate evidence:** `orkestrator-test-run.0gcS1v/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.0gcS1v/rerun-apps-web-src-lib-build-pipeline-agent-test-ts.log.gz` in the host temporary directory.

The cause is unconfirmed. The hypothesis is a shared preload hook (DOM registration or a global reset in `tests/setup.ts`) stalling on I/O under contention. Before raising any budget, reproduce under load and find which preload hook ran past five seconds.
