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

## Hidden-window Electron specs review — 2026-11-13

`mise run flaky:recurrence 1303 --base 17d28238c098b4443d1289df5c4ed75e7cc2802e`
reported `open`. On `electron-hidden-window-9b885cf8c702-r1` (macOS 27.2
arm64, Electron 45.2.3), whose diff adds two Electron specs to the suite's
`testMatch` and leaves this spec and its imports unchanged,
`mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
failed the same way twice: at review preparation on `4a9290b53` (65 passed,
1 failed, 9 skipped, 7 did not run) and again in the address-findings rerun on
`97f0c5dc6` (64 passed, 1 failed, 10 skipped, 7 did not run, 10.3 min). Both
times the only failure was `HMR v2 not applied in place` after the 30 s
predicate, and the five later serial cases did not run. The owner was not
rerun alone again: it already fails alone on this host and on clean `main`
(above).
