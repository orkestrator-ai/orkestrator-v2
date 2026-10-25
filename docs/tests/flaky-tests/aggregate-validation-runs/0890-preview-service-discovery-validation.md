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

## Review fixes and coverage validation — 2026-10-25

The six preview review fixes and their focused regression suites passed, including real dual-stack wildcard and distinct-interface listeners, automatic recovery, exhausted TTL retry windows, setup-terminal roots and cleanup, confirmation during resolution, container agent-link scope, both confirmation buttons, readiness labels, command counters/output, and different-kind entry-port registrations. `mise run check` passed; the changed source/test files also linted without warnings. The final formatting check passed after the validation notes were updated.

### Repository suite

`mise run test:logged -- --name preview-repository -- mise run test` failed in the workspace group after 1475.7 s. Root/agent-support, bridges, and Codex protocol lockfile groups passed. Web used two isolated Bun workers and reported 9677 passed, ten skipped, one failed across 612 files. Backend used two workers and reported 11328 passed, 84 skipped, four failed and two between-test errors across 673 files. Other worktrees and browser checks were active on the shared host.

- `apps/backend/src/core/change-tracking/review-regressions.test.ts`: `untracked inventory caps publish non-exact Git scope totals` exceeded Bun's five-second deadline (6365.85 ms). `cumulative A to B to A revisions survive pulls and acknowledgments while exact redelivery dedupes` then failed (903.88 ms), with closed-database errors also reported by background publication after the timeout. The complete unchanged owner passed separately with `mise run test:logged -- --name preview-change-tracking-owner -- bun test --cwd apps/backend ./src/core/change-tracking/review-regressions.test.ts --parallel=1 --only-failures` (exit 0, 15.8 s). The pass establishes intermittence; a timeout/cleanup interaction is a hypothesis, not an established cause.
- The native-command projection-read assertion failed both in aggregate and its unchanged owner (18 passed, one failed); this observation remains non-green. See [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md).
- The Mermaid watchdog elapsed-time assertion failed both in aggregate and its unchanged owner (12 passed, one failed); this observation remains non-green. See [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md).
- The OpenCode background agent-tool configuration count remained one after its fixed 150 ms wait. Its complete unchanged owner passed separately (2.2 s); see [0320](../native-agents-and-transcripts/0320-opencode-agent-tools-background-reconcile.md).

Evidence: host temporary artifacts `orkestrator-test-run.hEERkC/preview-repository.log.gz` and `orkestrator-test-run.0vNQwf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No failing repository assertion, timeout, or skip was changed.

### Browser suites

`mise run test:logged -- --name preview-browser-components -- mise run test:browser` ran 842 component scenarios with nine workers: 716 passed, 102 skipped, 24 failed (1251.0 s). The public-site phase did not run because the component phase failed. The failed scenarios concern branch suggestions, pane movement, setup recovery, terminal history, transcript paging, agent usage/interactions, coordinator focus, design, settings, GitHub setup, styles, shortcuts, and attachments. They are outside the preview changes; the remaining failures were not classified as flakes or hidden. Full failure names and evidence are preserved in `orkestrator-test-run.PQ8XNU/preview-browser-components.log.gz` under the host temporary directory.

The adjacent setup-recovery owner was checked separately: `mise run test:logged -- --name preview-setup-recovery-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/SetupRecovery.spec.ts --workers=1` passed all four desktop/mobile cases (20.3 s). In aggregate, `failed setup retry receives clicks above a laid-out native tab` at `e2e/SetupRecovery.spec.ts:36` (mobile) could not find the laid-out Codex setup overlay within five seconds at line 26. The unchanged owner pass establishes intermittence; the cause is unconfirmed.

The isolated real-stack browser suite reported 31 passed, 58 opt-in skips and one design-layout failure (858.8 s). Its complete design owner still failed (one passed, one failed; 194.8 s). Both runners stopped/reset their disposable profiles. See [0380](../design-canvas-and-artifacts/0380-design-text-fallback-pane-persistence.md) for the exact commands, failure points and evidence.
