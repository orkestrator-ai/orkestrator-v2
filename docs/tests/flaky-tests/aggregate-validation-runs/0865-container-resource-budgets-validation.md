# Container resource budgets validation

- **ID:** 0865
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0022. The built-in default container budget
  (`packages/protocol/src/container-resources.ts`,
  `apps/backend/src/core/container-resources.ts`, `commands-containers.ts`),
  the `setContainerResourceLimits` storage setter, the Settings and
  environment resources UI, and the benchmark and workload harnesses.
- **Original command:** `mise run test` (default reservations). It waited
  578 s for worker slots shared with other worktrees' runs; the host load
  average was about 50 on 18 cores.
- **Aggregate result:** failed after 1729.4 s, with the workspace group
  failing. Backend reported 11292 passed and 2 failed; web 9661 passed and 0
  failed. Every failure is in a file the change does not touch:
  - `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts`:
    `executable document policy in chromium` (5002.84 ms).
  - `apps/backend/src/core/opencode-host-start.test.ts`: `local OpenCode
    server starts on one host > shutdown between database-lock attempts
    prevents a retry spawn`.
  - `apps/desktop/tests/preview-transport-manager.test.ts`:
    `PreviewTransportManager (desktop tunnel end to end) > hiding does not
    close the listener; the last release retires it and frees the
    attachment`; see
    [0790](../previews-annotations-and-gateway/0790-preview-transport-attachment-release-timing.md).
  - `apps/desktop/scripts/dev/coordinator-live.test.ts`: `fixture tree digest
    > names every class of change a coordinator could make` (5021.15 ms); see
    [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md).
- **Owner reruns (unchanged files, alone, default timeouts):** both backend
  files passed together (48 passed, 0 failed), and both desktop files passed
  together (68 passed, 0 failed).
- **Evidence:** `orkestrator-test-run.ytqcGR/` under the host temporary
  directory.

No assertion, timeout or skip was changed. Shared-host contention is a
possible contributor, not an established cause. The aggregate exit stays
failed.
