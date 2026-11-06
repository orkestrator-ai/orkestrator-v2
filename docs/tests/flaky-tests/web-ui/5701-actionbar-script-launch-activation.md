# ActionBar script launch activation assertion

- **ID:** 5701
- **Status:** open
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
