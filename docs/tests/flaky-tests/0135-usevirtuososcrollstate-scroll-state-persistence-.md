# `useVirtuosoScrollState > scroll state persistence > keeps retrying until the Virtuoso handle is ready while the scroller stays mounted` (`tests/unit/hooks/useVirtuosoScrollState.test.ts:1576`)

- **ID:** 0135
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run immediately after a full `apps/web` suite and a bridge suite on the same host.
- **Failure:** reported only as a failing case in the run's compressed artifact (`root-tests.log.gz`); duration 65.08 ms. Suite counts for that run were not captured before the artifact rotated.
- **Isolated rerun:** `bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts` → 75 passed, 0 failed, run five consecutive times. A subsequent full `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures` also passed (3,767 passed, 0 failed, 166.5 s).
- **Attribution:** observed while `useVirtuosoScrollState.ts` was under change (persisted-snapshot validation). That change is inert for this case: the added code runs only inside the `persistKey` branch of the mount-time `useState` initializer, and this test constructs the hook without a `persistKey`, so it returns `undefined` exactly as before. The failing behaviour is the activation-retry loop, which the change does not touch.
- **Hypothesis:** the case asserts the retry loop after a single fixed `setTimeout(…, 30)`, having arranged for the Virtuoso handle to arrive on the 4th readiness read. Those reads are driven by `requestAnimationFrame` through `schedulePendingActivationScroll`, so the 30 ms budget only holds while happy-dom's rAF stays near-instant; under host contention four frames can exceed it and the assertion runs before the handle is ever read as ready. A recurrence should wait on the observable condition (poll until `reads > READY_AFTER`, or until `scrollToIndexCalls` is non-empty) instead of a fixed delay, rather than enlarging the 30 ms, which only moves the same race.
