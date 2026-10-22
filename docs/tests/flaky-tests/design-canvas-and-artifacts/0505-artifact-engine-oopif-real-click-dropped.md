# Artifact engine qualification: real click into an out-of-process frame dropped under load

- **ID:** 0505
- **Status:** resolved
- **Date observed:** 2026-10-20
- **Tests:** `executable document policy in chromium > popups, new-window links and top navigation reach the sink zero times` and `executable document policy in chromium > through the shell, every self-navigation, popup, form and redirect reaches the sink zero times`
- **Owner:** `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts`
- **Scope:** uncommitted rich-transcripts work on branch `implement-document-spec-6ba26bffea80-r1` (base `67a6cc31`), while adding the browser viewer shell tests to the owning file.
- **Original command:** `mise run test:logged -- --name backend-transcript-artifacts -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/transcript-artifacts --parallel=4'`, alongside the CPU-heavy `preview-runaway.test.ts` and `preview-escape.test.ts`.
- **Failure:** Chromium only. The first test's restricted loop timed out after 15 s waiting for the button handler's `clicked` probe after `frame.click("#popup")` (22112.71 ms). The second test's `frame.click("#popup")` into the nested artifact frame returned with the handler never run (`expected "popup", received null`, 16956.77 ms). No sink assertion failed: the click never reached the handler.
- **Suite counts:** 317 pass, 2 fail across 32 files.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/transcript-artifacts/content-server.engines.test.ts` from `apps/backend` passed (39 pass, 0 fail), before and after the fix.
- **Evidence:** `orkestrator-test-run.6fYWUD/backend-transcript-artifacts.log.gz` below the host temporary directory.
- **Root cause (hypothesis, consistent with both cases):** under heavy CPU load Chromium can drop input that Playwright routes to an out-of-process (cross-site) iframe before the frame's hit-test data is ready; the same-origin control frames, which are in-process, never showed it.
- **Fix:** the owning file's `realClick` helper repeats the real click (up to three attempts, 3 s each) until the handler confirms it ran (the `clicked` probe, or the frame's `data-clicked` marker through the shell), and the test asserts that it ran. Sink assertions are unchanged: a repeated click is a repeated attempt, so zero sink requests remain the requirement.
- **Verification:** the same parallel directory run then passed 319 pass, 0 fail across 32 files (233 s); the owning file alone passed 39 pass, 0 fail.
