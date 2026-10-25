# Container rebuild state preservation validation

- **ID:** 0815
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0021: OpenCode host seeding narrowed to `auth.json` (`docker/entrypoint.sh`, `portable-inputs.ts`), the `host-mounts` and policy-1 opt-outs removed (`commands-containers.ts`, `container-network.ts`), a new runtime generation on restore (`recovery-copies.ts`), and xattrs on the volume copy producer (`docker/orkestrator-migrate.sh`).
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` (default reservations). The live Docker replacement and rebuild-fault suites ran on the same daemon at the same time, and other worktrees were validating; host load average was 54–65.
- **Aggregate result:** failed after 1416.7 s, with failing groups workspace and bridges. Backend reported 10459 passed and 3 failed. Every failure is in a file the change does not touch:
  - `bridges/codex-bridge/src/messages/coalescer.test.ts`: `UpdateCoalescer > publishes eventually at the interval selected for a schedule`.
  - `apps/desktop/tests/preview-partition-retention.test.ts`: `PreviewPartitionRetention > a scheduled reconcile stops once its transport closes`.
  - `apps/desktop/scripts/dev/coordinator-live.test.ts`: `fixture tree digest > names every class of change a coordinator could make` (5018.76 ms); see [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md).
  - `apps/desktop/tests/preview-transport-manager.test.ts`: `PreviewTransportManager (desktop tunnel end to end) > hiding does not close the listener; the last release retires it and frees the attachment`.
  - `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx`: `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning`.
  - `apps/backend/src/core/commands-agent-tools.test.ts`: `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation`.
  - `apps/backend/tests/standalone-ready.test.ts`: `waitForStandaloneBackendReady > escalates SIGTERM to SIGKILL after the grace period`.
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery re-links submodules of an adopted or abandoned copy` (5051.39 ms); see [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).
- **Owner reruns (unchanged files, alone, `--parallel=1` through `test:logged`):**
  - Passed on the first rerun: the codex coalescer, desktop partition retention, desktop transport manager, web agent commands, backend agent tools and backend standalone-ready owners.
  - `environment-move.test.ts` failed its first logged rerun. It then passed directly (37 passed, 0 failed) and on a second logged rerun.
  - `coordinator-live.test.ts` timed out at 5 s in two logged reruns with load still around 54. With `--timeout 30000` it passed (48 passed, 0 failed).
- **Evidence:** `orkestrator-test-run.ZzOknn/` under the host temporary directory.

No assertion, timeout or skip was changed. Shared-host contention, made heavier by the concurrent live Docker suites, is a possible contributor, not an established cause. The aggregate exit stays failed.
