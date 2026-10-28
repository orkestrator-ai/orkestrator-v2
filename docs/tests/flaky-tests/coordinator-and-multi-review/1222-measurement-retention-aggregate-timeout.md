# Measurement retention times out in aggregate validation

- **ID:** 1222
- **Status:** open
- **Owner:** `apps/backend/src/core/change-tracking/measurement-retention.test.ts`

On 2026-10-28, socket type-of-service guard review preparation failed
`mise run test` in the unchanged retention owner. `retention prunes a backlog
in batches, sparing selected and restorable ones` timed out after 10,031.74 ms
against its 5,000 ms test deadline. The next test, `a single large measurement
is pruned in strict row batches and reader pins are counted`, then reported
`RangeError: Cannot use a closed database` from the timed-out test's work.
The backend group reported 9,904 passed, 87 skipped and two failed tests across
651 files (207.28 seconds), using the default tier's four-worker backend pool.

The complete owning file passed unchanged when rerun alone through:

```sh
mise run test:logged -- --name retention-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/measurement-retention.test.ts --parallel=1
```

The isolated run took 4.7 seconds. The aggregate failure is recorded in
`.orkestrator/review-artifacts/review-validation-718526c1-13d2-4dd8-aa63-6778b1a57ec1/validation-04.stdout.txt`.
Host contention is a possible contributor; the cause is unconfirmed. No test
assertion or timeout was changed.

The required `mise run test` rerun reproduced the same pair of failures:
the backlog test took 8,355.96 ms, followed by the same closed-database error
in the next case (128.22 ms). The backend again reported 9,904 passed,
87 skipped and two failed tests across 651 files (265.16 seconds). Its evidence
is retained with the default-suite rerun's failure artifacts. The desktop
package reported 1,274 passed, 16 skipped and zero failed tests in that run.
