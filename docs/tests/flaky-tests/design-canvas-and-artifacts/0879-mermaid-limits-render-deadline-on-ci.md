# Mermaid size-limit case hit the render deadline on CI

- **ID:** 0879
- **Status:** resolved
- **Date observed:** 2026-10-25 (first CI failure 2026-10-23)
- **Test:** `mermaid rendering > enforces source bytes, edges and SVG limits at and over the boundary`
- **File:** `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts:170`
- **Original command:** CI `main`, job "Unit and integration tests", `mise run test` / `mise run test:full` on `ubuntu-latest` (four cores).
- **Failure:** the 2,000-note sequence diagram returned `render_timeout` ("Diagram parse/layout exceeded 5000 ms and the renderer was terminated") instead of `package_size_exceeded` for `svg`.
- **Occurrences:** 26 of the 44 failing `main` CI runs from 2026-10-23 (`39985615373`) to 2026-10-25 (`40189950916`): the most frequent `main` failure in that window. It has not failed locally (18-core macOS).
- **Root cause:** the case renders five diagrams at once on a runner admitting five, so five Chromium layouts share four cores. The 2,000-note diagram's layout then passed the production 5 s render deadline before its SVG could be counted. The case tests the size limits; the render deadline has its own case (`the external watchdog ends a blocked render within the deadline …`).
- **Fix:** on branch `todo-0030-test-suite-ci-health-e11a519267e2`, that runner gets `budgets: { mermaidRenderMs: 20_000 }` (below the 30 s worker wall budget). Every other budget and every limit stays at its production value, and so do the production deadline and its watchdog case.
- **Verification:** see the todo 0030 evidence (CI probe run on GitHub Actions).
