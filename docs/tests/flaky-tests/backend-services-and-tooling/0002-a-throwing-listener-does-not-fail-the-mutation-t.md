# `a throwing listener does not fail the mutation that succeeded` (`apps/backend/src/core/storage/resource-events.test.ts`)

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
  bun --cwd=apps/backend test src/core/storage/resource-events.test.ts
  --parallel=2 --only-failures` → passed (0.4s).
- **Hypothesis:** the case deliberately throws from a listener, and the
  background reject/trailing-error accounting that contains it is timing
  sensitive under aggregate load. The change in flight (the parked-dispatch
  reconcile grace window) touches only the native-agent projection and the
  retry/discard card, not storage or resource events. A recurrence should
  capture the `announce` rejection boundary before changing the handler or the
  assertion.

## Investigation (2026-11-15), still open

- **No timing in the test:** the case has no timer, poll or deadline. It installs a listener that throws and awaits `addProject`. The product code that must contain the throw (`StorageChanges.announce` in `apps/backend/src/core/storage/changes.ts`, the only place the listener is invoked) wraps every subscriber in `try`/`catch`, and the code at the recorded date (`storage-base.ts` at `4ed76e1c9`) did the same. Nothing in the current or recorded code explains a mutation rejecting with the listener's own error after the catch had already logged it.
- **Not reproduced:** the unchanged owner passed `-t "throwing listener" --rerun-each=30` (`mise run test:logged -- --name f1-0002-stress -- ...`). A contention run (`--burners 6 --rerun-each=5`) did not finish in 500 s because the host load average was 100 to 180 from other workers' runs, and was stopped; it is not evidence either way.
- **Why it stays open:** there is no deterministic repair to make (no wait to replace). The remaining hypothesis in the case, trailing-error accounting attributing another test's unhandled rejection to this one, is not supported by anything observed. A recurrence should capture the full output around the failure (the `listener.change-failed` log line and any unhandled error between tests) before anything is changed.
