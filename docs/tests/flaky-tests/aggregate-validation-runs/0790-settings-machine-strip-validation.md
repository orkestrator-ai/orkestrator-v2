# Settings machine-strip validation

- **ID:** 0790
- **Status:** open
- **Date observed:** 2026-10-24
- **Change under test:** Settings header machine picker, with every per-machine settings section routed to the chosen machine (web renderer, `apps/web/src/lib/backend/*`, root GlobalSettings/SettingsPage tests).
- **Original command:** `mise run test` (default reservations; other worktrees validating concurrently on the same host).
- **Aggregate result:** failed after 543.3 s. Root/support failures caused by the change (GlobalSettings, SettingsPage and test-diagnostic-bounds expectations) were fixed in the same change and their owners pass. The remaining failures were five-second timeouts in files the change does not touch:
  - `bridges/cursor-bridge/src/initial-run.test.ts`: `replaces an unused warm agent when a read-only prompt changes its policy` (5001.32 ms).
  - `apps/desktop/scripts/dev/coordinator-live.test.ts`: `fixture tree digest > names every class of change a coordinator could make` (5013.68 ms).
  - `apps/backend/src/core/coordinator-service.test.ts`: `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` (5082.51 ms); see [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md).
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery re-links submodules of an adopted or abandoned copy` (5166.33 ms); see [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).
- **Owner reruns:** each complete unchanged owner passed alone with `bun test <file>` from its package: backend pair 93 passed (36.97 s), desktop 48 passed (2.42 s), cursor bridge 18 passed (4.41 s).
- **Evidence:** `orkestrator-test-run.TPZZNA/` under the host temporary directory.

No assertion, timeout or skip was changed for these four tests. Shared-host contention is a possible contributor, not an established cause.
