# Coordinator actions do not reopen on focus after a reduced-motion resize

- **ID:** 9920
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `reduced motion shows and hides without a transition in both modes`,
  desktop Chromium, `e2e/CoordinatorActions.spec.ts:426` (assertion at line 441).
- **Branch base:** `04639b12b71d4326a3b8941485367aca197f4966`.
- **Observed commit:** `b7d1c28ac3` on `fix-flaky-tests-b39eb845189b-r1`.
- **Aggregate command:** `ORKESTRATOR_E2E_PORT=52481
  ORKESTRATOR_PUBLIC_E2E_PORT=52482 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4
  mise run test:logged -- --name address-browser -- mise run test:browser`.
  Four component workers ran beside default-suite validation. Final aggregate
  counts are recorded in the Address Findings workflow result.
- **Failure:** after changing from 1600×900 to 390×844 and focusing the
  transcript control and then the Actions icon, `aria-expanded` stayed `false`
  rather than `true` for the 5,000 ms assertion deadline.
- **Complete owning-file rerun:** `ORKESTRATOR_E2E_PORT=52481 mise run
  test:logged -- --name address-coordinator-actions-owner -- bunx playwright
  test --config e2e/playwright.config.ts e2e/CoordinatorActions.spec.ts
  --workers=1 --output=output/agent-testing/address-findings-coordinator-actions`
  passed, exit 0, in 313.4 seconds. It scheduled 34 cases. No assertion,
  timeout, skip, fixture or product implementation was changed for the rerun.
- **Evidence:** aggregate log directory `orkestrator-test-run.irrhBn` under
  the host temporary directory; failure context and trace under
  `output/playwright/test-results/CoordinatorActions-reduced-62a06--a-transition-in-both-modes-desktop-chromium/`.
  The passing owner summary is in `orkestrator-test-run.7jeAEl/summary.json`;
  the logged runner deletes passing raw output.
- **Assessment:** the isolated owning-file pass establishes intermittence,
  not a cause or an unrelated-to-branch verdict. The branch changes shared
  floating-notice subscriptions, but this observation does not establish
  whether they affect the failure. Breakpoint reconciliation versus focus
  ordering is an unverified hypothesis.
- **Next step:** capture the docked/overlay mode and focus event ordering
  around the resize before choosing a product fix or a test precondition.
  Do not increase the deadline or skip the test.


## Notes review repair — 2026-11-10

**Base and recurrence.** This observation uses base
`c98b20e6f6332895320b84b8edfd1f3cc9542ba0` and observed head
`79d3d65552ca19049bfbee79cf51c9c8584d4ec5`. The read-only
`mise run flaky:recurrence -- 9920 --base c98b20e6f6332895320b84b8edfd1f3cc9542ba0`
classified it as an open recurrence.

**Reproduced: yes.** The nine-worker command
`mise run test:logged -- --name review-fixed-browser -- mise run test:browser`
reported 1,665 passed, 152 skipped and one failed in 1,225.9 s. The mobile
reduced-motion case kept `aria-expanded=false` rather than `true` for 5,000 ms
at line 441. The complete unchanged one-worker owner reproduced the same
assertion on desktop (33 passed, one failed, 109.3 s):

```sh
mise run test:logged -- --name review-fixed-coordinator-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorActions.spec.ts --workers=1 --output output/agent-testing/review-fixed-validation/coordinator-owner
```

The failing logs are `orkestrator-test-run.BUNOh8/review-fixed-browser.log.gz`
and `orkestrator-test-run.7Q2DHZ/review-fixed-coordinator-owner.log.gz` under
the host temporary directory. Original browser evidence is retained under
`output/agent-testing/review-fixed-validation/coordinator-actions-original/`.

**Root cause and fix.** Changing the viewport precedes delivery of the layer's
resize observer. The folded icon already exists in docked mode, where focus
correctly does not open it, so its unchanged `aria-expanded=false` is not a
narrow-layout readiness signal. An isolated browser probe held resize observer
callbacks, reproduced the focused-but-folded icon, released the callbacks, and
verified that focus opens it once the narrow Agent Mail pill appears. Both
notices consume the same measured layer state. The test now waits for that
pill before moving focus. No product behavior, assertion, timeout, retry or
skip changed.

**Verification.** The controlled browser probe passed through `test:logged`
(`coordinator-resize-probe`, 9.9 s). The repaired case passed in both browser profiles, five repeats at three
workers (13.4 s), with the exact command below.
The final committed-head full validation is reported in the implementation
handoff.

```sh
mise run test:logged -- --name coordinator-resize-fixed -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorActions.spec.ts --grep 'reduced motion shows and hides' --repeat-each=5 --workers=3 --output output/agent-testing/notes-repair-coordinator-fixed
```
