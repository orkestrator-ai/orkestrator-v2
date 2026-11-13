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


## Uniform app shortcuts review rerun — 2026-10-28

The exact preparation command was repeated after the shortcut fixes:

```sh
mise run test:logged -- --name agent-electron -- mise run test:agent:electron
```

Result: 37 passed, one skipped, one failed and five later serial cases not run
(492.6 seconds, one worker). HMR again failed at the 30-second in-place update
predicate, this time for v2. Artifact, design-canvas, realm shortcut and native
preview keyboard/overlay scenarios passed. Failure evidence:
`orkestrator-test-run.5YBcmg/agent-electron.log.gz` below the host temporary
directory. No HMR implementation, assertion, timeout or skip changed.


The complete unchanged owner also failed alone, with the same v2 predicate:

```sh
mise run test:logged -- --name service-preview-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/service-preview-electron.spec.ts --workers=1
```

11 passed, one failed, five later serial cases not run (137.7 seconds).
Evidence: `orkestrator-test-run.Yvz6n6/service-preview-electron-owner.log.gz`
below the host temporary directory. This remains a failure that reproduces
in the owner, not a newly established aggregate-only flake.

## 4340 Electron rerun on macOS — 2026-11-13

- **Branch and base:** Branch `electron-suite-rerun-4896909ed3cc-r1`, base `17d28238c` (4340 (retired) task 5, which changes no desktop or Electron spec code). `mise run flaky:recurrence -- 1303 --base 17d28238c`: open, record as a recurrence.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=electron-4340 mise run test:logged -- --name agent-electron -- mise run test:agent:electron` (one Playwright worker, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), on this Mac (macOS 27.2, Apple silicon) shared with nine other builds; the failure snapshot's CPU meter read 100 %.
- **Failure:** `HMR v2 not applied in place` (`service-preview-electron.spec.ts:2218`), test 51.3 s. Suite: 43 passed, 4 failed, 6 skipped, 25 not run (serial cases behind a failure), 25.9 min.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=electron-4340-solo-service-preview-electron mise run test:logged -- --name solo-service-preview-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts` failed the same way alone (16 passed, 1 failed, 7 skipped, 114.8 s; `orkestrator-test-run.gaZb1A/solo-service-preview-electron.log.gz`), so it still reproduces in the owner on macOS, as on 2026-10-28.
- **Evidence:** `orkestrator-test-run.2kT16D/agent-electron.log.gz` below the host temporary directory; results and traces under `output/agent-testing/electron-4340/electron/`; rerun under `output/agent-testing/electron-4340-solo-service-preview-electron/electron/`.
- **Changes:** evidence only; no HMR implementation, assertion, timeout or skip changed.

