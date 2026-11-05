# Static Find review aggregate assertions

- **ID:** 6041
- **Status:** open
- **Date observed:** 2026-11-05
- **Original command:** `mise run test`, prepared at `c0808605ddf1d4ecb421db6493f91018f1199b56`; concurrent aggregate groups, granted worker configuration not retained in the review package.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-72ace150-e330-4d03-bde1-fdc95c60e6e0/validation-04.stdout.txt`.
- **Suite counts:** preparation reported six web failures and six backend failures, plus the root flake-register metadata failure. The triage could not name every failure.

Two unchanged owners passed alone during address-findings:

- `web gateway browser API > reassembles a direct fetch frame split across chunk boundaries`, `apps/web/src/lib/native/web-gateway.test.ts`: aggregate threw happy-dom `Invalid URL` at line 3304 (4.07 ms). `mise run test:logged -- --name gateway-alone -- bun --cwd=apps/web test ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures` passed, exit 0, 2.1 s.
- `a main closed while its wake is on the way > a close during main reconciliation leaves report kind unselected until adoption`, `apps/backend/src/core/coordinator-delegation-wakes.test.ts`: aggregate expected `report`, received `notice`. `mise run test:logged -- --name recorded-wake-failure -- bun --cwd=apps/backend test ./src/core/coordinator-delegation-wakes.test.ts --parallel=1 --only-failures` passed, exit 0, 5.8 s.

No root cause established. Neither owning implementation nor test was changed; keep the assertions. Passing runner logs were deleted by test:logged. This records aggregate-only behavior, not proof that the failures are unrelated to the branch.
