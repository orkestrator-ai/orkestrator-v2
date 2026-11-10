# `CreateEnvironmentFlowDialog.test.tsx` Bun worker crash (`tests/unit/components/CreateEnvironmentFlowDialog.test.tsx`)

- **ID:** 0018
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Root cause:** a Bun 1.4.0 runtime crash, not test code: the runner
  reported a `SIGSEGV` panic in the worker with no assertion failure, and the
  owner passed alone against the same tree. The crash was never attributed to
  a specific API in this file.
- **Fix:** the toolchain moved off Bun 1.4.0: `cc61effd4` (#637, 2026-09-08)
  pinned 1.4.2, `478e515bf` (#964) 1.4.3 and `ebc0a83c8` (#1229) the current
  1.4.4. There has been no recurrence in the 73 days since the only
  observation (2026-08-29), during which the owner also changed in 11
  commits. No test or budget changed in this entry.
- **Reproduced:** no — a `SIGSEGV` inside Bun cannot be induced from the test,
  and the crashing runtime is no longer pinned. Evidence that it is gone is a
  stress run only, which is weaker; reopen on any `SIGSEGV` in this owner
  under Bun 1.4.4 or later, with Bun's crash report.
- **Stress:** `mise run test:logged -- --name stress-0018-0137 -- bun scripts/test-under-contention.ts -- bun test ./tests/unit/components/CreateEnvironmentFlowDialog.test.tsx ./tests/unit/components/FeaturesView.test.tsx --parallel=2 --rerun-each=20`
  passed on Bun 1.4.4 (exit 0, 218 s, no worker crash, host load average
  about 34).
