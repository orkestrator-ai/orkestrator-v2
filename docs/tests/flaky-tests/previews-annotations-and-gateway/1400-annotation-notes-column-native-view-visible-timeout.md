# Annotation Notes column case misses the native preview's visible deadline under load

- **ID:** 1400
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `the real Notes column shrinks the native view, overlays hide it, and the narrow switch swaps surfaces`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts:1526`
- **Original command:** `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts` (one worker, the config's setting) on branch `todo-0880-desktop-modal-dialogs-4539ddba3d6a` (based on `931e55417`), with the host's load average at about 16 to 19 from other workers' suites.
- **Failure:** `expect(received).toBe(expected)`, expected `true`, received `false`, `Timeout 5000ms exceeded while waiting on the predicate`, in `showRendererPreview` at `:1438` (`nativePreviewView()?.visible`), reached from the test at `:1529`. File result: 7 passed, 1 failed, 6 not run, in 25.1 s.
- **Isolated reruns:** the unchanged owner file passed 14/14 twice straight after, at a load average of about 5 to 7. The same test also passed in the full `mise run test:agent:electron` run just before the failure.
- **Hypothesis:** the 5 s default poll is too short for the view to become visible on a saturated host. Not established, and no A/B against `main` was run. No assertion, timeout or skip changed.
