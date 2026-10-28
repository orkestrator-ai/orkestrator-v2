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
