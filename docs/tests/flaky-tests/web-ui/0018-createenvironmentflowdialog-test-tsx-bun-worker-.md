# `CreateEnvironmentFlowDialog.test.tsx` Bun worker crash (`tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`)

- **ID:** 0018
- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root/agent-support group used six Bun workers while the workspace and
  bridge groups were also active.
- **Failure:** Bun 1.4.0 crashed this file's worker with `SIGSEGV` after 17.61 s
  and aborted the remaining sibling files. The runner explicitly identified it
  as a Bun bug rather than a test assertion.
- **Suite counts:** root/agent-support reported 1,954 passed and 88 failed
  across 2,042 tests; the 88 failures include files aborted after the worker
  panic, not 88 independent assertions.
- **Isolated rerun:** `bun test tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`
  passed 33/33 with 116 assertions in 1.55 s before the aggregate run, against
  the same tree.
- **Hypothesis:** the available evidence establishes only an aggregate-only Bun
  runtime crash. The same run also pushed unrelated timing tests into
  multi-minute durations, so a recurrence should retain Bun's crash report and
  process/resource diagnostics before changing this file's tests.
