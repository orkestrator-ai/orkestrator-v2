# Preview service discovery (0045) validation: backend five-second timeouts

- **ID:** 0890
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0045 (local-environment preview seeding, loopback listener ownership, port-move re-registration, agent links to preview tabs, framework setup hints) on `todo-0045-preview-service-discovery-810be430b445`, based on `20f6de91`.
- **Original command:** `mise run test` (default reservations; other worktrees validating on the same host, load average about 28 to 34 on 18 cores when it finished).
- **Aggregate result:** failed after 961.0 s in the workspace group with two backend failures in tests whose behaviour the change does not touch. Web, root, bridges and the Codex protocol lockfile groups passed.
  - `apps/backend/src/core/change-tracking/acceptance-storage.test.ts`: `acceptance: storage durability, retention and representation > H11: crashes around object publication, ledger commit and outbox drain recover without dangling references` (5054.98 ms, `orphan capture failed`). No earlier case.
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery re-links submodules of an adopted or abandoned copy` (5061.96 ms); see [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md), recurring as in [0820](0820-multi-review-scale-cost-validation.md) and [0825](0825-dependency-upgrades-0032-validation.md).
- **Owner reruns:** `bun test --cwd apps/backend ./src/core/change-tracking/acceptance-storage.test.ts --parallel=1` passed (2.2 s); `bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1` passed (37.0 s). Neither file imports preview, terminal-runtime or local-server-runtime code changed here.
- **Evidence:** `orkestrator-test-run.ivl8IZ/` under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host load is the likely contributor, not an established cause.
