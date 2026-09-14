# Test bootstrap mock-registration cascade (`apps/web` and root renderer tests)

- **ID:** 0054
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test`
- **Worker configuration:** workspace web tests used two workers and the root
  group used four workers; independent workspace, root, bridge, and protocol
  groups ran concurrently.
- **Failure:** Hundreds of otherwise unrelated renderer tests reported that
  central native-backend functions were no longer Bun mocks (for example,
  `nativeInvokeMock.mockClear is not a function`) or observed shared DOM/mock
  state. One recorded root result was 3,338 passed, 1 skipped, and 345 failed.
- **Isolated rerun:** The affected `AgentInfoButton.test.tsx`,
  `NativeMessage.test.tsx`, `GlobalSettings.test.tsx`,
  `TerminalComposeBar.test.tsx`, `HierarchicalSidebar.test.tsx`,
  `useNativeComposeBarPaste.test.tsx`, `useAgentState.test.tsx`,
  `usePrMonitorService.test.tsx`, `useProjects.test.ts`, and
  `terminal-paste.test.ts` files all passed when run in their own processes.
- **Hypothesis:** Confirmed by the fix below; this was bootstrap ordering, not
  independent product regressions.
- **Root cause:** `tests/setup.ts` used a top-level dynamic import after Happy
  DOM registration. Bun could begin test-module evaluation before the
  post-`await` central `mock.module()` registrations completed.
- **Fix:** Happy DOM registration moved into the earlier synchronous
  `tests/register-dom.ts` preload. `tests/setup.ts` and all central mocks remain
  synchronous while Testing Library still evaluates after a document exists.
- **Verification:** The affected focused files passed, a six-worker root stress
  run passed in 81.7 seconds, and the complete concurrent suite passed in 84.7
  seconds with no failures.
