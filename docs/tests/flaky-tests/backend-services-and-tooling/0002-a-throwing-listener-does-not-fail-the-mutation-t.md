# `a throwing listener does not fail the mutation that succeeded` (`apps/backend/src/core/storage-resource-events.test.ts`)

- **ID:** 0002
- **Status:** open
- **Date observed:** 2026-09-11.
- **Original command:** `mise run test:changed`, default aggregate plan
  (`scripts/test-all.ts` ran four groups concurrently; the backend workspace used
  two Bun workers).
- **Failure:** `expect(storage.addProject(...)).resolves.toMatchObject(...)` saw
  the mutation reject with the listener's own `Error: client transport is
  broken`, after the storage layer logged
  `[Storage] Resource change listener threw`. The backend group reported 3061
  passed, 1 skipped, 1 failed across 3063 tests in 199.38s; every other group
  passed.
- **Isolated rerun:** `mise run test:logged -- --name storage-resource-events --
  bun --cwd=apps/backend test src/core/storage-resource-events.test.ts
  --parallel=2 --only-failures` → passed (0.4s).
- **Hypothesis:** the case deliberately throws from a listener, and the
  background reject/trailing-error accounting that contains it is timing
  sensitive under aggregate load. The change in flight (the parked-dispatch
  reconcile grace window) touches only the native-agent projection and the
  retry/discard card, not storage or resource events. A recurrence should
  capture the `announce` rejection boundary before changing the handler or the
  assertion.
