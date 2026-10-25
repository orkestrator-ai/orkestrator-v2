# Cursor steer route escape-heavy ids hook timeout

- **ID:** 0855
- **Status:** open
- **Observed:** 2026-10-25, `todo-0066-residual-module-state-40e8f98a7ef0` branch validation
- **Test:** `steer route > escape-heavy ids at the allowed length hit the byte cap before the count cap`
- **File:** `bridges/cursor-bridge/src/steer-journal.test.ts`

## Failure

- **Original command:** `mise run test` (the aggregate `scripts/test-all.ts`),
  workspace/root/bridges/protocol reservations 4/1/2/1; the bridges group ran
  with two worker slots alongside the workspace and root groups.
- **Message:** `^ a beforeEach/afterEach hook timed out for this test.` after
  10004.61 ms.
- **Counts:** cursor-bridge 791 pass, 1 fail, 792 tests across 44 files
  (53.03 s); the bridges group finished FAIL after 166.7 s.
- **Evidence:** `orkestrator-test-run.20ctxb` under the host temporary
  directory (`/var/folders/hc/.../T/`).

## Isolated rerun

```sh
cd bridges/cursor-bridge
bun test src/steer-journal.test.ts
```

21 pass, 0 fail (1.72 s).

## Notes

The branch does not change any bridge code
(`git diff 20f6de911 --stat -- bridges` is empty); it moves backend module
state into `BackendRuntime`. The sibling bounded-steer case 0216 was a hook
timeout from many fsync'd state publications under load; the same contention
is a plausible hypothesis here, not established.
