# Keyed build scheduling aggregate timeouts

- **ID:** 0205
- **Status:** open
- **Date observed:** 2026-10-13
- **Original command:** `mise run test:logged -- --name fix-full-suite -- mise run test`
- **Worker configuration:** normal aggregate allocation; backend used one Bun worker while root and bridge groups and component/isolated browser validation ran on the host.
- **Failures:** `BuildPipelineService keyed scheduling > old and new drivers make the same transitions from one persisted fixture` timed out at 5147.39 ms; `BuildPipelineService keyed scheduling > retained history is enumerated only by the safety scan` timed out at 5000.59 ms in `apps/backend/src/core/build-pipeline-scheduling.test.ts`.
- **Associated errors:** late work read a null pipeline snapshot in `phaseOf`, and the safety scan observed 44 scanned records instead of 123 after the timed-out tests.
- **Suite counts:** backend reported 5877 passed, 15 skipped and 25 failed; 22 failures were environment-move cleanup errors and one was an annotation quota hook timeout.
- **Isolated rerun:** `mise run test:logged -- --name fix-scheduling-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-scheduling.test.ts --parallel=1 --only-failures` passed (exit 0, 2.9 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.Pv387k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** scheduler progress and fixture cleanup exceeded the generic test deadline under aggregate load or shared backend activity. The owning test and backend were unchanged; the cause is unconfirmed. No test was skipped or timeout raised.
