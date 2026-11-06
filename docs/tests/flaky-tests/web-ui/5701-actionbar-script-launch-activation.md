# ActionBar script launch activation assertion

- **ID:** 5701
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `ActionBar editor and run commands > activates an unknown script launch but skips activation when launch throws`
- **File:** `apps/web/src/components/layout/ActionBar.test.tsx:2205`
- **Original command:** `mise run test`, preparation at `ce2f0e201509091ff6a42466e2e9314d12ac2b05`.
- **Worker configuration:** concurrent aggregate workspace run; exact granted worker count was not included in the review package.
- **Failure:** expected no activation mock calls, received one; duration 419.43 ms.
- **Suite counts:** web 12,490 passed, 4 failed, 10 skipped. Backend separately reported 15,284 passed, 3 failed, 132 skipped and two errors.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-ecbb4fec-f505-44e0-8394-2baa28af371d/validation-04.stdout.txt`, lines 3455–3466.
- **Isolated rerun:** `mise run test:logged -- --name address-actionbar-triage -- bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx --parallel=1 --only-failures` passed the whole owning file in 64.3 seconds, exit 0, on 2026-11-05 after the tmux test helper typing repair. Passing output was deleted by the logged runner.
- **Scope:** no ActionBar implementation or test was changed. Triage marked it related through a transitive import of `client-only-messages.ts`; the added mail presenter is invoked by the tmux tab, not this script-launch test.
- **Hypothesis:** unresolved; the aggregate-only mock assertion is insufficient to identify a cause. Keep the assertion and investigate on recurrence.

## Recurrence 2026-11-06 — coordinator Work panel removal

`mise run test:logged -- --name address-default-suite-final -- mise run test`
failed with the same assertion (zero activation calls expected, one received)
at 602.91 ms, with two web workers. Web totals: 12,989 pass, 10 skip,
one failure. Backend: 16,359 pass, 126 skip, zero failures. Evidence:
`/tmp/orkestrator-test-run.OehO21/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(outer runner: `/tmp/orkestrator-test-run.XT3YoW`).

`mise run test:logged -- --name address-actionbar-isolated -- bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel=1 --only-failures`
passed the unchanged complete owner in 25.1 s, exit 0. The branch changes no
ActionBar source or test; no timeout, assertion or skip was changed. Cause
remains unresolved. All backend tests passed in this aggregate.

## Recurrence 2026-11-06 — merge origin/main into Work panel removal

`mise run test:logged -- --name merge-default -- mise run test` failed with
zero activation calls expected and one received at `ActionBar.test.tsx:2205`
(2004.08 ms), with two web workers. Web totals: 13,013 pass, 10 skip, one
failure. Backend: 16,398 pass, 131 skip, zero failures. Root, bridges and the
Codex protocol check passed. The aggregate finished in 437.2 s. Evidence:
`/tmp/orkestrator-test-run.M6FGVM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(outer runner: `/tmp/orkestrator-test-run.uDshLL/merge-default.log.gz`).

`mise run test:logged -- --name merge-actionbar-isolated -- bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel=1 --only-failures`
passed the complete unchanged owner in 10.2 s, exit 0. Neither the original
conflicts nor the resolution edits touch ActionBar source or tests. No
assertion, timeout or skip was changed. Cause remains unresolved; this is a
recurrence of the existing flake, not a green aggregate result.

### Resolution — 2026-11-06

**Root cause.** The test passed only while its second press landed inside the
double-press window. `claimTabLaunch` holds an accepted or `unknown` launch's
claim for `TAB_LAUNCH_CLAIM_MIN_MS` (600 ms, added in #1755 after this test
was written). A second "Create run script" inside that window was refused
before reaching the backend, so the rejecting `launchNativeAgentJob` mock never
ran and nothing was activated. When the aggregate delayed the second press past
600 ms (the failures ran 419–2004 ms), the launch really ran. `beginTabLaunch`
then focused its placeholder at press time, as designed ("focus moves when the
user presses"), and the expectation of zero activations failed.

**Reproduction.** Inserting a 700 ms wait before the second press reproduced
the exact failure (expected 0 calls, received 1).

**Fix.** `apps/web/src/components/layout/ActionBar.test.tsx`: like the
neighbouring Push test, the case calls `resetTabLaunches()` before the second,
later press, so the throwing launch always runs. It now asserts what a thrown
launch does: two backend calls, exactly one activation (the second press's own
placeholder, by the `tabId` sent to the backend), no activation of any landed
tab, the error alert, and no launch left in `useTabLaunchStore`.

**Verification.** With the 700 ms wait inserted, the fixed case passed. Then
`mise run test:logged -- --name web-actionbar-owner -- bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx`
passed (exit 0, 41.5 s), and
`mise run test:logged -- --name web-actionbar-script-stress -- bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx -t "script launch" --rerun-each=20`
passed (exit 0). Case 4312 is the same test.
