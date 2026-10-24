# Mermaid watchdog wall-clock deadline under aggregate load

- **ID:** 0518
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone`
- **File:** `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts:191`
- **Original command:** `mise run test:logged -- --name review-final-full -- mise run test` alongside another checkout's complete suite and browser validation.
- **Failure:** the watchdog elapsed assertion expected less than 9000 ms and observed 9375 ms (test duration 9887.41 ms).
- **Suite result:** the backend group reported 9870 passed, 68 skipped and two failed across 9940 tests. The other failure came from a new containment assertion while the suite was already running during its implementation edit; it is not classified as a flake.
- **Stable-code validation:** `mise run test:logged -- --name review-backend-final -- bun run --cwd apps/backend test:workspace` passed the entire backend suite (349.6 s).
- **Owning-file rerun:** `mise run test:logged -- --name review-mermaid-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1` passed the unchanged owning file alone (18.5 s).
- **Evidence:** `orkestrator-test-run.BEgua1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` in the host temporary directory.
- **Hypothesis:** browser process launch and scheduling contention consumed the watchdog's margin. The Mermaid implementation, assertions, deadlines and skips were unchanged.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 24.5 s: `mise run test:logged -- --name design-links-owner-mermaid -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.
