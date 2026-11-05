# Claude resumed-root preference retention during aggregate validation

- **ID:** 1221
- **Status:** open
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
