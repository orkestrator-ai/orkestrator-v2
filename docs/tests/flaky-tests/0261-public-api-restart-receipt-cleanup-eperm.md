# Public API restart receipt fixture cleanup hits EPERM

- **ID:** 0261
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `request keys and receipts > a replay after a restart returns the original receipt without re-executing`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts:185`
- **Original command:** `mise run test:logged -- --name final-tests -- mise run test`. The aggregate used four workspace slots (two workers per package), one root worker, two bridge slots, and one protocol slot.
- **Failure:** Fixture cleanup at `public-api/test-support.ts:143` threw `EPERM: operation not permitted, rm '/tmp/ork-public-api-…'` after the replay assertions. The case took 11.04 ms. The backend package reported 8,098 pass, 40 skip, 3 fail, and 40,462 assertions across 440 files in 275.12 seconds.
- **Isolated rerun:** `mise run test:logged -- --name public-api-isolated -- bun test --cwd apps/backend ./src/core/public-api/public-api-projects.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 3.2 seconds).

## Current assessment

The unchanged owning file passes alone. The failure is in recursive temporary-directory removal rather than receipt replay. Concurrent fixture teardown or host filesystem activity may explain the transient permission error; the evidence does not establish which. No cleanup assertion, timeout, or production public API behavior was changed.

The subsequent settled-snapshot aggregate (`stable-final-tests`) did not reproduce this failure; its backend failures were the existing preview-tunnel flake and the unchanged HTTP provider module-size boundary.
