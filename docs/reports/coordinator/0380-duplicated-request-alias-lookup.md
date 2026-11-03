# Duplicated request-alias lookup

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Share the lookup**: one helper for reading a request alias. Status: open.

### 1. Share the lookup

**Problem.** Two copies of an idempotency lookup can drift, and a mismatch would decide whether work starts twice.

**Context.** Retention added alias timestamps, which raised the number of places aliases are read and written.

**Investigation.** `requestAlias` at `coordinator-review-actions.ts:34-45` (used at `:350-355`), against the inline form at `storage-coordinators.ts:613-630`.

**Decisions.** None: export one helper from `storage-coordinators.ts` or the retention module and use it in both.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
