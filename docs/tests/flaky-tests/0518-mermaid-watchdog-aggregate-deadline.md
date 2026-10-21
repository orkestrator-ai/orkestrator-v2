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
