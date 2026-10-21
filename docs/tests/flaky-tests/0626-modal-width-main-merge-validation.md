# Modal-width main-merge validation

- **ID:** 0626
- **Observed:** 2026-10-21
- **Merge baseline:** `1a365c12069dc8f8b2333a9cc608434378e28f8c`
- **Merged main:** `4608d8299`
- **Scope:** All 311 merged paths changed from the pre-merge HEAD, plus this validation record.
- **Conflict:** `PreviewServiceDialog.tsx` retains `sm:max-w-md` and main's
  `onCloseAutoFocus` callback. No test assertion, timeout or skip was changed.

## Confirmed flakes

The complete repository command (`mise run test`, through `test:logged`)
finished in 1023 seconds. Bridge and protocol-lockfile groups passed; workspace
and root/support groups failed on the five cases discussed below. No group
hit its watchdog or output bound. The workspace package results were: protocol
1721 passed, public web 41 passed, desktop 1105 passed, toolchain 91 passed,
CLI 148 passed, web 8618 passed/1 failed, and backend 9903 passed/2 failed.
The root/support group reported 3171 passed, 1 skipped, 2 failed and one error
associated with the disk-report timeout.

The component browser command used dedicated ports because port 1422 belonged
to another checkout:

```sh
ORKESTRATOR_E2E_PORT=21422 ORKESTRATOR_PUBLIC_E2E_PORT=24423 mise run test:logged -- --name merge-browser-owned-port -- mise run test:browser
```

It reported 367 passed, 80 skipped and seven mobile failures: one DesignCanvas
timeout, three PaneBreakpoint startup failures, two SetupRecovery missing-overlay
failures, and one TerminalCornerToolbar touch-history failure. Every complete,
unchanged owning file then passed sequentially with one worker (74.6 seconds):

```sh
ORKESTRATOR_E2E_PORT=21422 mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/PaneBreakpoint.spec.ts e2e/SetupRecovery.spec.ts e2e/TerminalCornerToolbar.spec.ts --workers=1
```

The public-site suite, which the initial component failure prevented from
starting, passed separately with `ORKESTRATOR_PUBLIC_E2E_PORT=24423` and
`--config e2e/public-site/playwright.config.ts --workers=1` (18.4 seconds).
Related existing cases are 0174, 0342, 0351 and 0237.

The repository aggregate also reported these failures whose unchanged owners
passed on rerun:

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `tests/unit/disk-report.test.ts` | Five-second timeout, subprocess status null | Passed in a sequential two-owner run with Pi vendoring; the Pi case still failed. Related case 0259. |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | `bounded concurrency and queues; caches converge within bounds over 20 scroll/expand cycles` exceeded 120 seconds | Whole owner passed alone in 44.1 seconds. |
| `apps/backend/tests/tmux-commands.test.ts` | `generated blocking hooks use an integer timeout and fail closed on expiry` expected three timeout records, observed two | Whole owner passed alone in 16.2 seconds. Related case 0141. |
| `apps/backend/src/core/agent-accounts.test.ts` | `the same login cannot be added twice` left an extra account directory | Whole owner passed alone in 8.8 seconds. Related case 0239. |

Reruns used `mise run test:logged` and `bun test` with explicit file paths and
`--parallel=1 --only-failures`; the backend owner used the Node-only preload.
Host contention is a hypothesis, not an established cause.

The isolated-stack browser command reported 28 passed, 42 skipped and one
failure in `browser-gateway.spec.ts`: the narrow host-picker case could not
click Repository settings within 15 seconds. Its disposable profile
`qa-browser-d853a9d5-266` was stopped and reset by the runner. The complete,
unchanged gateway owner then passed alone on a fresh credential-free fixture
profile in 188.1 seconds:

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=merge-modal-gateway-173c590 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-modal-gateway-173c590 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1
```

That profile was stopped and reset after the rerun. This occurrence is a
confirmed flake; earlier unresolved gateway observations remain in case 0623.

## Pi vendoring reruns

Pi runtime vendoring timed out in the aggregate and the first two unchanged owner
reruns, including one after the component and isolated-stack browser suites
finished. The latter reported three passed and one failed in 31.8 seconds.
After the entire repository aggregate finished, the complete unchanged owner
passed alone in 10.9 seconds:

```sh
mise run test:logged -- --name merge-pi-owner-after-aggregate -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures
```

This final rerun establishes a flake for this occurrence (related cases 0178
and 0514). No Pi implementation, dependency or assertion changed during this
merge. Every failing owning file eventually passed unchanged; the original
aggregate and browser suite exit statuses remain failed.

## Evidence

Private artifacts under the host temporary directory:

- `orkestrator-test-run.SO82HY/merge-browser-owned-port.log.gz`
- `orkestrator-test-run.jDNmj8/`: repository aggregate group logs.
- `orkestrator-test-run.LnLLy3/merge-root-failed-owners.log.gz`: disk-report
  passed, Pi runtime staging still hit its 30-second deadline (8 passed, 1 failed).
- `orkestrator-test-run.B5TowQ/merge-pi-owner-after-browser.log.gz`: Pi staging
  remained non-green on the second owner rerun, before the final passing rerun.
- `orkestrator-test-run.P7rIlw/merge-real-stack-browser.log.gz`: isolated-stack
  browser failure and successful profile cleanup.

Passing checks also included both frozen dependency installations, version drift,
formatting after the imported ActionBar prose was formatted, lint, all typechecks,
all workspace builds, focused modal regression tests and the complete Electron
suite. iOS, Docker opt-in and billed-provider suites were outside this merge's
validation scope.
