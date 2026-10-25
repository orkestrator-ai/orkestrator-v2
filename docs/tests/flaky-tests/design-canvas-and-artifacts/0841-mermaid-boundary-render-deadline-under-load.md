# Mermaid boundary diagrams exceed the render deadline under host load

- **ID:** 0841
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `mermaid rendering > enforces source bytes, edges and SVG limits at and over the boundary`
- **File:** `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts:126`
- **Original command:** `mise run test` (workspace/root/bridge/protocol groups concurrent) while another worktree ran its complete suite and browser validation; load average 6–19 on 8 cores.

## Two causes, one fixed

The test renders five diagrams concurrently, each against the 5,000 ms
parse/layout deadline (`MERMAID_POLICY.renderTimeoutMs`).

1. **Fixed: oversized SVG-limit fixture.** The case that must fail with
   `package_size_exceeded`/`svg` used a 2,000-note sequence diagram. Rendering it
   alone took 7,267 ms at load 3.6, so it failed with `render_timeout`
   (`mermaid-render`) before the SVG check could run, both in the aggregate and
   in every owner rerun. Probe timings, render solo: 500 notes 3,286 ms (2,049
   elements), 1,000 notes 5,147 ms (4,049), 1,500 notes 6,527 ms (svg limit),
   2,000 notes 7,267 ms (`render_timeout`). The fixture is now a 2,000-slice pie
   (6,007 elements, 26.9 KB of source, 2,283 ms solo). It passed in all three
   loaded owner reruns below. The assertions are unchanged.
2. **Open: the 250-edge flowchart at the edge limit times out under load.**
   `expect(at250.ok).toBe(true)` (line 165) failed in the aggregate and in three
   consecutive complete-owner reruns while load averaged 12–19. Rendered alone at
   load 15, the same diagram took 8,854–11,008 ms and returned `render_timeout`.
   The complete owner with this assertion passed alone twice earlier the same
   day on a quieter host (35.0 s; 30.7 s at load 2.8). This is the policy's own
   boundary: a 250-edge diagram is required to render, so the deadline and
   assertion were not changed.

## Evidence

- Aggregate: `orkestrator-test-run.Bcqex1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  (backend 11,235 passed, 141 skipped, 2 failed across 11,378 tests; the other
  failure was 0512).
- Loaded owner reruns with the pie fixture:
  `mise run test:logged -- --name mermaid-pie-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures`
  failed only on `at250` and the 0512 watchdog bound (artifacts
  `orkestrator-test-run.mi6NsY`, `.2jsIp5`, `.TQdGEC`; loads 3.4→13.1→12.3).
- A quiet-host rerun of the pie version could not be obtained: load stayed
  above 19 for 30 minutes because other worktrees were running Chromium suites.

## Hypothesis

Five concurrent Chromium renders compete with other worktrees' browser suites
for CPU, and the fixed 5,000 ms parse/layout deadline has no margin for that.
Re-run the complete owner on a quiet host before treating a recurrence as a
regression.
