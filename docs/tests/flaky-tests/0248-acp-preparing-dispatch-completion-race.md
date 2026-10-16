# ACP cold-dispatch assertion races turn completion

- **ID:** 0248
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `ACP bridge > does not confirm a request while a cold session load is still preparing it`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:1332`
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test`. The aggregate used four workspace worker slots, one root worker, two bridge slots (one worker per package), and one protocol slot.
- **Failure:** At line 1382 the final dispatch response contained `{ dispatch: "dispatched", turn: { state: "completed" } }`, while the assertion expected exactly `{ dispatch: "dispatched" }`. The case took 980.50 ms; the ACP package reported 555 pass, 3 skip, 1 fail, and 2,227 assertions in 72.42 seconds.
- **Isolated rerun:** `mise run test:logged -- --name acp-isolated -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 13.8 seconds).

## Current assessment

The owning file passes alone. The last response is read after prompt acceptance and can already include an authoritative turn outcome when the fixture finishes quickly. Aggregate scheduling appears to change whether completion wins that race. The earlier assertion still observed `unknown` while loading. No assertion, timeout, or production ACP behavior was changed for this observation.

The subsequent `mise run test:logged -- --name final-tests -- mise run test` aggregate passed the complete bridge group (90.1 seconds).
