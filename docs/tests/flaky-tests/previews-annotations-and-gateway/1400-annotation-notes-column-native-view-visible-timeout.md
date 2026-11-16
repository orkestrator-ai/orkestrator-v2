# Annotation Notes column case misses the native preview's visible deadline under load

- **ID:** 1400
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `the real Notes column shrinks the native view, overlays hide it, and the narrow switch swaps surfaces`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts:1526`
- **Original command:** `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts` (one worker, the config's setting) on branch `todo-0880-desktop-modal-dialogs-4539ddba3d6a` (based on `931e55417`), with the host's load average at about 16 to 19 from other workers' suites.
- **Failure:** `expect(received).toBe(expected)`, expected `true`, received `false`, `Timeout 5000ms exceeded while waiting on the predicate`, in `showRendererPreview` at `:1438` (`nativePreviewView()?.visible`), reached from the test at `:1529`. File result: 7 passed, 1 failed, 6 not run, in 25.1 s.
- **Isolated reruns:** the unchanged owner file passed 14/14 twice straight after, at a load average of about 5 to 7. The same test also passed in the full `mise run test:agent:electron` run just before the failure.
- **Hypothesis:** the 5 s default poll is too short for the view to become visible on a saturated host. Not established, and no A/B against `main` was run. No assertion, timeout or skip changed.

## Triage note (2026-11-15)

Not changed. Recorded failure: a 5 s native-view poll in Electron. Electron specs and their configs were not run or edited in this pass (shared with other groups, and unverifiable here); no spec-local explicit signal could be justified without a live reproduction. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** a Playwright default deadline expiring on a loaded host while waiting on a real signal. The recorded failure is `Timeout 5000ms exceeded while waiting on the predicate` in `showRendererPreview`'s `expect.poll` for `nativePreviewView()?.visible`, which passes no timeout of its own and so used the 5 s assertion default.
- **Fix:** `e2e/agent-testing/playwright.electron.config.ts`, which lists `web-annotations-electron.spec.ts`, now sets `expect: { timeout: 30_000 }` (Playwright's default was 5 s) beside its existing `timeout: 120_000`. The poll still passes no explicit timeout, so it now waits up to 30 s.
- **Reproduced:** no — not run: the Electron suite needs a display and a live stack, which this pass did not start. The fix rests on a raised hang-watchdog budget, which is weaker evidence than a reproduction.
- **Reopen if:** the same poll fails again as a hang near the new 30 s budget.
