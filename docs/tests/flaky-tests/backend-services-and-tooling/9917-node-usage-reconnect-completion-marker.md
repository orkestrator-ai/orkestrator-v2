# Reconnect usage assertion observes invocation before notification completion

- **ID:** 9917
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Base commit:** `60c065c366e65ffc7d7cc1fb32e4c4517fc661ac`
- **Observed head:** `fc703331f5df3c3ee903d433c691401ddf9af1ca`
- **Test:** `shared usage readings > a node that reconnects catches up from the central copy`
- **File:** `apps/backend/src/core/nodes/node-usage-sync.test.ts:286`
- **Command:** `mise run test:logged -- --name fixes-full-tests -- mise run test`
- **Workers:** default concurrent aggregate, Linux x86_64, Bun 1.4.4.
- **Failure:** expected an `agent-usage-readings-changed` notification, received an empty event array (11.81 ms).
- **Package counts:** backend 17,720 pass, 140 skip, one fail; every other group passed.
- **Evidence:** `/tmp/orkestrator-test-run.TcFmNh/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner immediately passed:
`mise run test:logged -- --name fixes-node-usage-isolated -- env -u NODE_ENV bun test --cwd apps/backend ./src/core/nodes/node-usage-sync.test.ts --parallel=1 --only-failures`
(0.6 s; passing log and counts removed by the runner).

## Resolution (2026-11-10)

**Root cause:** the fake link pushed `node.applied` at invocation entry. The
reconnect test used that marker as completion, although the real store updates
its cache before awaiting persistence and emitting the notification. The value
could therefore be visible before Settings had been notified.

**Fix:** record `applied` only after the real apply function finishes. Keep the
value and notification assertions. The reconnect test now holds the return from
the store's record operation, proves data is already visible but `applied` is
still empty, releases the hold, and checks the final notification.

**Reproduced:** yes. With that controlled hold and the original entry marker,
`mise run test:logged -- --name repro-node-usage-boundary -- env -u NODE_ENV bun test --cwd apps/backend ./src/core/nodes/node-usage-sync.test.ts --parallel=1 --only-failures --test-name-pattern 'a node that reconnects'`
failed: expected an empty completion list, received one entry (zero pass, one
fail, nine filtered). Evidence:
`/tmp/orkestrator-test-run.DKtsfW/repro-node-usage-boundary.log.gz`.

**Verification:** the same controlled boundary passes after moving the marker.
`mise run test:logged -- --name fix-node-usage-boundary-regression -- env -u NODE_ENV bun test --cwd apps/backend ./src/core/nodes/node-usage-sync.test.ts --parallel=1 --only-failures --rerun-each=10`
passed (0.6 s; individual counts not retained).

**Stress:** before adding the controlled hold, the corrected marker passed
`mise run test:logged -- --name fix-node-usage-contention -- env -u NODE_ENV bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend ./src/core/nodes/node-usage-sync.test.ts --parallel=1 --only-failures --rerun-each=10`
(7.0 s). No timeout or assertion was loosened.
