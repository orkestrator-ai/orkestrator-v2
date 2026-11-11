# Assigned-composer shortcut startup misses the editable wait

- **ID:** 1902
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `Meta+I focuses the assigned agent composer and leaves the terminal chord usable` (mobile Chromium).
- **File:** `e2e/KeyboardShortcuts.spec.ts:308`.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Workers:** five Playwright workers; default aggregate and isolated-profile browser validation also ran on the shared host.
- **Failure:** the textbox under `[data-pane-leaf]` with a contenteditable was absent at the 5000 ms editable wait. The broad browser command later hit the logged runner's 1800 s group deadline, after reaching case 1122 of 1166; it did not produce final pass/fail totals or run the public-site suite.
- **Complete unchanged mobile owner:** `mise run test:logged -- --name repair-keyboard-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --project mobile-chromium --workers=1 --output output/agent-testing/mail-review-owners/keyboard` passed all 30 cases in 228.5 s, exit 0.
- **Evidence:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.LaDtCt/browser.log.gz`. Passing owner output was removed by the bounded logger.

This is an intermittent startup observation, not a root-cause diagnosis. No
keyboard implementation, assertion, timeout or skip changed in this review.


## Backend logger review repair — 2026-11-02

The four-worker browser rerun repeated the exact missing editable textbox at
`KeyboardShortcuts.spec.ts:318`. Command:

```sh
ORKESTRATOR_E2E_PORT=50454 ORKESTRATOR_PUBLIC_E2E_PORT=50455 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name review-fix-browser -- mise run test:browser
```

After the failure was diagnosed and its owner rerun, the broad run was
intentionally interrupted at 1,038.5 s: 311 passed, five failed, four
interrupted, 62 skipped, 822 not run. The other four failures were the retained
PR snapshot and zoomed divider cases in MultiReviewFlow (case 1120). The
public-site suite did not run. Evidence: host temporary artifact directory
`orkestrator-test-run.bSlWGN`, `review-fix-browser.log.gz`.

The complete unchanged mobile keyboard owner passed all 30 cases with one
worker (438.2 s, exit 0):

```sh
ORKESTRATOR_E2E_PORT=50454 mise run test:logged -- --name review-fix-keyboard-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --project=mobile-chromium --workers=1 --output output/playwright/keyboard-owner
```

That rerun shared the fixture server and host with the broad browser run; it
was a one-file, one-worker check, not a claim of host isolation. No keyboard
implementation, assertion, timeout or skip changed.


## Coordinator merge validation — 2026-11-03

The broad browser run repeated the missing editable textbox at line 318 with
nine workers while other worktrees were validating on the shared host:

```sh
ORKESTRATOR_E2E_PORT=61879 mise run test:logged -- --name merge-browser-retry -- mise run test:browser
```

The broad run was intentionally interrupted to scope validation to the original
coordinator conflict: 174 passed, one failed, nine interrupted, 58 skipped,
1,064 not run (261.1 s). Evidence: host temporary artifact directory
`orkestrator-test-run.JB6VPy`, `merge-browser-retry.log.gz`.

The unchanged failing case passed alone with one worker (22.2 s, exit 0):

```sh
ORKESTRATOR_E2E_PORT=61880 mise run test:logged -- --name keyboard-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --project=mobile-chromium --workers=1 --grep 'Meta\+I focuses the assigned agent composer'
```

This rerun selected the failing case, not the complete owner file. No keyboard
implementation, assertion, timeout or skip changed. The startup-delay hypothesis
remains unproven.

## Launch override review recurrence — 2026-11-05

The required browser rerun on repair commit `c63d42e7a` repeated the missing
editable textbox at line 318 in mobile Chromium. The command was
`ORKESTRATOR_E2E_PORT=54487 mise run test:logged -- --name browser -- mise run test:browser`,
with five Playwright workers on the shared host. Its output is retained at
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.EQqosx/browser.log.gz`.
The broad run was still active when this owner rerun finished; its eventual
result is recorded separately in the Address Findings validation result.

The complete unchanged mobile owner passed with one worker (exit 0,
406.6 seconds):

```sh
ORKESTRATOR_E2E_PORT=54487 mise run test:logged -- --name browser-keyboard-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --project=mobile-chromium --workers=1 --output=output/playwright/keyboard-address
```

Passing output was deleted by the bounded runner, so no per-test totals were
retained. This owner reused the broad run's fixture server; it was a
single-file rerun, not an idle-host qualification. No owner assertion, timeout,
skip or fixture logic changed. The cause of the intermittent observation
remains unestablished.


### Broad rerun outcome

The bounded runner stopped the broad command at its 1,800 s absolute deadline
(exit 1), after the reporter started case 856 of 1,596. It named three failed
cases but emitted no closing component totals; the public-site phase did not
run. `summary.json` alongside the compressed log records `timeoutReason:
"absolute"`. The broad check remains incomplete; passing this owner does not
waive that timeout or establish a green browser suite.

## Coordinator unavailable-platform review — 2026-11-06

Both mobile Meta+I cases (assigned and fresh agent) lacked an editable composer at the 5 s assertion.
The five-worker browser repeat named nine failures and hit the 1800000 ms
group deadline after starting 708/1596 cases; complete pass totals are not
available. The command was
`ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser`.

The unchanged complete owner passed alone, exit 0, in 301.1 s:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-shortcuts-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=1 --output output/agent-testing/review-address-owners/shortcuts
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`.
Passing output was deleted by the logged runner; individual passing counts
were not retained. This establishes intermittence, not a cause or an overall
browser pass. No assertion, timeout, skip or implementation was changed.

## Keyboard-shortcut review fixes — 2026-11-11

Base commit `498b68766f5c9f357a3a86782406d1e9e0977559`
(`mise run flaky:recurrence -- 1902 --base 498b68766` answered open). The
mobile assigned-agent case again found no editable composer at the 5 s
assertion during a full owner run with Playwright's default workers on a
macOS host (63 passed, 1 failed; the run added a design-frame entry case to
this spec and a second field to the fixture's design frame, neither of which
the failing case uses). Command:

```sh
ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name keyboard-shortcuts-browser -- bunx playwright test --config e2e/playwright.config.ts KeyboardShortcuts.spec.ts
```

The unchanged case passed alone, exit 0, in 6.8 s:

```sh
ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name kbd-1902-alone -- bunx playwright test --config e2e/playwright.config.ts KeyboardShortcuts.spec.ts --project mobile-chromium -g "Meta\+I focuses the assigned" --workers 1
```

No assertion, timeout, skip or implementation was changed.
