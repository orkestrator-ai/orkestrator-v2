# Small logging and metrics hygiene left over

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Remove `cursorDebugEnabled`**: dead code with no production caller. Status: open.
2. **Correct comments naming `/api/metrics`**: the route is `/__orkestrator/metrics`. Status: open.

### 1. Remove `cursorDebugEnabled`

**Problem.** A function reads `CURSOR_BRIDGE_DEBUG` and nothing uses it.

**Context.** No recommendation covers it; L10 lists it. The per-bridge flags were replaced by `ORKESTRATOR_BRIDGE_DEBUG` and live policy.

**Investigation.** `bridges/cursor-bridge/src/run-diagnostics.ts:12` defines it, and the only other references are its tests (`run-diagnostics.test.ts:8`, `:62-63`).

**Decisions.** None: delete the function and its test.

### 2. Correct comments naming `/api/metrics`

**Problem.** Comments send a reader to a route that does not exist.

**Context.** M2 notes this. No recommendation covers it.

**Investigation.** `API_PREFIX` is `/__orkestrator` (`apps/backend/src/gateway-support-core.ts:195`). `/api/metrics` appears in comments at `commands-registry-system.ts:66`, `:76`, `compatibility-path-usage.ts:81` and `recurring-diagnostics.ts:14`.

**Decisions.** None: mechanical comment edits.

## Current state

The rest of L10 is done or no longer applies:

- **Tag variants** went with the migration to fixed areas (`docs/architecture/logging.md:794-884`).
- **Buffered debug logger** aggregates and flushes (R4; `bridge-diagnostics.ts:684`, `:696`).
- **Bridge stderr at `error`** stays by design for raw text, which has no level (`logging.md:604`, `:824`).
- **Unfiltered environment** is [0830](0830-r10-vendor-debug-environment.md).

## Related

- [Logging and database report, L10](../2026-10-29-logging-and-database-efficiency.md#l10-consistency-low) and [the metrics findings, M2](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
