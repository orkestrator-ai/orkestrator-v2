# Claude resumed-root preference retention during aggregate validation

- **ID:** 1221
- **Status:** resolved
- **Date observed:** 2026-10-28
- **Test:** `a root turn the warm CLI starts on its own > signal death after the prompt settled retains a restart interruption`
- **File:** `bridges/claude-bridge/src/services/session-manager-runtime-idle.test.ts:591`

During the `skip-validation-step-5c0fa92ea681-r1` merge of main parent
`8a6bc2f841ad5b8c2035b9dd98d1962afc800ca9` into branch parent
`53d1e5695ba3404099216d3c5fc691c450aa55f5`, `mise run test` failed this
case because the persisted preferences had no `turnInFlight`. The aggregate
reported 90.27 ms for the case. Neither parent nor the manual merge resolution
changes this owning test file. Other validation was running concurrently.

The complete unchanged owner passed alone (exit 0, 1.0 s):

```sh
mise run test:logged -- --name merge-claude-runtime-recheck -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures
```

Aggregate evidence is in `orkestrator-test-run.Xy7MuA/bridges.log.gz` below
the host temporary directory after completion. This confirms an intermittent
failure; its cause is not established. No bridge implementation, assertion,
timeout, or skip was changed.

## Merge-readiness review recurrence — 2026-10-28

The `mergeable-pr-environment-shimmer-09258728cf65` review rerun repeated the
same missing `turnInFlight` assertion (62.44 ms) in `mise run test`.
No bridge source or tests changed. The complete unchanged owner passed alone
(exit 0, 2.2 s):

```sh
mise run test:logged -- --name claude-runtime-owner -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.fjlb7l/bridges.log.gz` in the host
temporary directory. This remains an intermittent failure with no established
cause; no assertions, deadlines or skips were changed.

## Egress repair qualification — 2026-11-05

At `9ffb0fe96c85388e942a3d0dff936053b024e0fa`,
`mise run test:logged -- --name egress-fixed-default -- mise run test`
repeated the missing persisted `turnInFlight` assertion at line 638 (40.16 ms).
The Claude group reported 1,866 passed, nine skipped and one failed.
The complete unchanged owner passed alone (exit 0, 0.4 s):

```sh
mise run test:logged -- --name egress-fixed-claude-idle-isolated -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.5SrDNz/bridges.log.gz` below the host temporary
directory; outer log `orkestrator-test-run.2EP93a/egress-fixed-default.log.gz`.
No cause is established and no bridge implementation, assertion or timeout changed.

## Work panel removal merge — 2026-11-06

Merging `295abd298b23a7ff90a2153545c76cd337d9cf33` into
`f366b85e80b8705e9bca63dbaebf5feb6eec8b83`,
`mise run test:logged -- --name merge-tests -- mise run test` repeated the
missing `turnInFlight` assertion at line 638 (110.37 ms). The Claude group
reported 1,874 passed, seven skipped and one failed; the aggregate scheduled
bridges with two worker slots and each bridge with one Bun worker. Other
validation ran concurrently. The complete unchanged owner passed alone
(exit 0, 2.5 s):

```sh
mise run test:logged -- --name merge-claude-idle-rerun -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.nqin2k/bridges.log.gz`; outer log
`/tmp/orkestrator-test-run.o6OOCw/merge-tests.log.gz`. No bridge code, test,
assertion or deadline changed. The cause remains unestablished.


## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, `mise run test:logged -- --name repair-default -- mise run test`
reported this unchanged case failing at line 638: persisted `turnInFlight` was
undefined. The bridges group used two package slots and one Bun worker per
bridge. Claude reported 1,872 passed, nine skipped and one failed across
1,882 cases. The outer command later hit its 30-minute deadline after waiting
about 23 minutes for the shared host lease.

Evidence: `orkestrator-test-run.HNKlxf/bridges.log` and
`orkestrator-test-run.Iu6GYp/repair-default.log.gz` under the host temporary
directory. The complete unchanged owner passed alone (exit 0, 1.4 s):

```sh
mise run test:logged -- --name isolate-claude-idle -- bun test --cwd bridges/claude-bridge ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures
```

The isolated pass confirms intermittence; the cause remains unconfirmed. Status
stays open. No implementation, assertion, timeout or skip changed.

### Resolution — 2026-11-06

**Root cause (test).** The session queues three turn-in-flight mark writes
without awaiting them (`syncTurnInFlightMark`): *set* when the prompt starts,
*clear* when it settles, *set* again when the warm CLI's resumed root takes the
foreground. The writes are serialized per session. The test polled until the
file showed any `turnInFlight`, so on a slow host the loop could stop on the
*first* set while the clear was still queued, and the following read then saw
the clear (`undefined`). The 62–110 ms failure durations match: the loop exited
at once rather than running out its 1 s budget. Traced by instrumenting the
writes (set, clear, set).

**Fix.** `bridges/claude-bridge/src/services/session-manager-runtime-idle.test.ts`
replaces the poll with `await settleSessionPreferenceWritesForTesting()` (the
existing preference-queue drain), then reads once. The harness
`bridges/claude-bridge/src/services/session-manager-test-harness.ts` now
re-exports that function. No assertion changed.

**Verification.**

- Reproduced before the fix: a temporary 100 ms delay on every mark write plus
  a 120 ms pause between the poll's last read and the assertion produced the
  exact failure (`Received: undefined`,
  `mise run test:logged -- --name br-1221-repro -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-runtime-idle.test.ts -t "signal death after the prompt settled"`, exit 1).
- With the fix and the same injected write delay: passed (exit 0). Delay removed afterwards.
- Complete owner three times (`br-1221-owner1..3`, exit 0), and twelve fresh
  processes under three extra CPU-bound loops
  (`mise run test:logged -- --name br-1221-loop -- bash -c 'cd bridges/claude-bridge && for i in $(seq 1 12); do bun test --preload ../../tests/setup-node.ts ./src/services/session-manager-runtime-idle.test.ts …; done'`, exit 0).
  The file is not `--rerun-each` safe (its persisted-session fixture fails on
  a second run in one process, before and after this change), so repetitions
  use fresh processes.
