# `MobileAppShellLayout > opens the project drawer on initial mobile entry and keeps workspace content mounted` (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **ID:** 0067
- **Status:** resolved
- **Later recurrence:** 2026-08-14 after the split below, on the close-button
  half rather than the initial-open half.
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c4cb555c-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the other workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The test exceeded Bun's 5,000 ms outer budget and timed out after 5,014.67 ms. No assertion failure was reported. An earlier observation of the same case on this date (`bun run test` into `/tmp/orkestrator-full-tests.log`, web package `bun test src --parallel`) timed out after 5,701.98 ms with no assertion failure; every other test in the owning file passed in that run, including the adjacent `toggles the project drawer closed with a second menu-button tap` at 17.51 ms.
- **Suite counts:** Web package: 4,805 total, 4,803 passed, 1 skipped, 1 failed across 210 files with 14,866 assertions in 104.69 seconds. The backend, root, bridge, protocol, CLI, desktop, and web-public groups passed.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-fix-mobile-layout-isolated.log` -> 23 passed, 0 failed in 4.41 seconds; the affected case passed in 2,197.66 ms. An earlier isolated rerun of the same file also passed 23/0.
- **Root cause:** The case combined the initial Radix drawer auto-focus boundary and a later close-and-restore focus boundary under one five-second test budget. The two behaviors are independent and each already has a distinct user-visible assertion, but their asynchronous focus work accumulated enough aggregate scheduling delay to exhaust the shared budget.
- **Fix:** Split the initial-open and close-button focus behaviors into separate tests so each transition has an independent lifecycle and budget without weakening either assertion.
- **Verification:** The owning file is stress-tested after the split and the subsequent aggregate result is recorded in this change's validation handoff.
- **Related aggregate-only recurrence (2026-08-14):** `closes the initial project drawer from its close button and restores trigger focus` (5,269.69 ms) and `closes the project drawer from its backdrop and restores trigger focus` (5,598.78 ms) timed out while the same file's other tests passed. The originally fixed `opens the project drawer on initial mobile entry and keeps workspace content mounted` case was not among the failures.
- **Original command:** `set -o pipefail; bun --cwd apps/web test src/components/native-agent/AgentNativeTab.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-agent-native-tab-isolated-final.log`
- **Worker configuration:** The command expanded the web package test script to Bun's 18-worker `bun test src --parallel` suite across 211 files; the extra path argument did not limit the package script.
- **Failure and suite counts:** 4,843 passed, 1 skipped, and 3 failed across 4,847 tests; the third failure was the deterministic unbounded-provider context-wheel assertion recorded and fixed in this change.
- **Isolated rerun:** `set -o pipefail; bun test --cwd apps/web ./src/components/layout/MobileAppShellLayout.test.tsx --parallel 2>&1 | tee /tmp/orkestrator-mobile-app-shell-layout-isolated.log` -> 24 passed, 0 failed, 111 assertions in 8.21 seconds; both affected cases passed.
- **Verification:** `set -o pipefail; bun run --cwd apps/web test 2>&1 | tee /tmp/orkestrator-web-full-coverage-fix.log` -> 4,846 passed, 1 skipped, 0 failed across 4,847 tests in 24.07 seconds.
- **Hypothesis:** The two affected cases each await Radix drawer close and focus restoration under the five-second default budget. Their 4.14-second and 3.00-second isolated durations, combined with the aggregate-only failure and a green subsequent aggregate, point to worker scheduling contention rather than a deterministic drawer behavior failure.
- **Recurrence (2026-08-14, initial-prompt image preview change):** `closes the
  initial project drawer from its close button and restores trigger focus` — one
  of the two cases the split above produced — timed out after 5,398.71 ms with no
  assertion failure during `bun test src --parallel` in `apps/web` (4,845 passed,
  1 skipped, 2 failed across 211 files in 214.19 s; the other failure is the
  separate context-wheel entry below). The first isolated rerun of the owning
  file also timed out at 5,000 ms, but three consecutive reruns after it passed
  24/0 (~5.4-12.3 s each), and the file passed 24/0 on a stashed clean tree.
  Unrelated to the change under test, which touches no layout, drawer, or focus
  code. The split reduced the frequency but did not remove the cause: the
  close-and-restore-focus transition still spends most of a 5,000 ms budget on
  Radix focus scheduling, so aggregate contention alone can exhaust it. Raising
  or removing that single budget is the next thing to evaluate.
