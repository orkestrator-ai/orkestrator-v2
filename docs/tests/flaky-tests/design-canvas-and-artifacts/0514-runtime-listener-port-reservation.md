# Artifact runtime listener port reservation race

- **ID:** 0514
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `content listener configuration > the runtime listens where configured and serves only the hosted origin's host`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/runtime-prepare.test.ts:147`
- **Original command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, while merging `origin/main` (`688f9f69`) into `682bd5be` on `fix-agent-test-host-home-writes-c7337a6ddd7f`.
- **Configuration:** workspace/root/bridge/protocol groups ran concurrently with 4/1/2/1 slots; backend used two isolated Bun workers. Isolated browser and Electron checks also ran on the host.
- **Failure:** runtime startup failed with `EADDRINUSE` for port 64156 at `content-server.ts:249`; test duration 3.62 ms.
- **Suite counts:** backend reported 9,751 passed, 67 skipped and one failed across 551 files in 386.73 seconds. All other workspace packages, root/support, bridges and protocol regeneration passed. Aggregate exit 1 after 405.0 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-runtime-prepare-rerun -- bun test --cwd apps/backend ./src/core/transcript-artifacts/runtime-prepare.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file, exit 0, in 0.5 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.EpyNaK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer log in `orkestrator-test-run.ZjBs4P` under the same temporary root.
- **Hypothesis:** the test obtains a free port from `Bun.serve`, stops that server, then binds a different listener to the released port. Another process may claim it between those operations, or the previous listener may not have fully released it; the failure does not distinguish these possibilities.
- **Changes:** evidence only; no implementation, assertions, timeout or skip changed.
- **Full-suite rerun:** `mise run test:logged -- --name merge-full-suite-rerun -- mise run test` passed all four groups, exit 0, in 388.6 seconds. No source or tests changed between runs.
