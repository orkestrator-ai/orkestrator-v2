# Build pipeline scheduling timeouts under aggregate load

- **ID:** 0205
- **Status:** open
- **Date observed:** 2026-10-13
- **Tests:** `BuildPipelineService keyed scheduling > old and new drivers make the same transitions from one persisted fixture`
  and `BuildPipelineService keyed scheduling > retained history is enumerated only by the safety scan`.
- **Owning file:** `apps/backend/src/core/build-pipeline-scheduling.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`,
  with the documented macOS GNU-tool PATH.
- **Worker configuration:** workspace packages `--parallel=1`, two package
  tasks; root, bridge and protocol groups also ran on the host.
- **Failures:** the tests exceeded their 5,000 ms deadlines at 5,003.38 ms and
  5,004.95 ms respectively.
- **Backend suite:** 5,875 passed, 15 skipped, 27 failed across 329 files in
  442.53 seconds; 22 failures reproduced as tmux cleanup errors on this host.
- **Isolated rerun:** with the same PATH,
  `mise run test:logged -- --name build-scheduling-rerun -- bun --cwd=apps/backend test ./src/core/build-pipeline-scheduling.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 5.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass supports load-sensitive scheduling or fixture work, but does
not identify the blocking operation. No assertions, deadlines or skips were
changed.
