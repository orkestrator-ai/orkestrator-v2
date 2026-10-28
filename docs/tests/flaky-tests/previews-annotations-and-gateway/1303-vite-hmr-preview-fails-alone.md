# Vite HMR preview journey fails alone on this host, on origin/main too

- **ID:** 1303
- **Status:** open
- **Date observed:** 2026-10-28
- **Test:** `a Vite app keeps HMR updates made while its tab is hidden, unmounted or reloaded`
- **File:** `e2e/agent-testing/service-preview-electron.spec.ts:1729`
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` on branch `uniform-app-keyboard-shortcuts-376ba22a2bd4` (based on `6a6009a09`), macOS 27.0 arm64, one worker, host load averages 11 to 35.
- **Failures:**
  - Full suite: `HMR v2 not applied in place` (30 s predicate).
  - Alone on the branch: `HMR v3 not applied in place`; last state `{"text":"preview-vite v2","updates":"1","kept":"kept"}` (88.6 s for the file, 16 of 17 passed).
  - Alone on a clean `origin/main` worktree (`6a6009a09`, `-g "HMR"`): `expect(received).toEqual(expected)` after a 30 s predicate timeout at line 702 (41.0 s).
- **Not a flake by the registry's rule:** the owner did not pass alone on either tree. It fails on `origin/main` unchanged, so the branch (keyboard shortcut routing) did not cause it.
- **Hypothesis:** Vite's HMR file watcher or update delivery is slow or stalled on this loaded host. Not established. No assertion, timeout or skip changed.
