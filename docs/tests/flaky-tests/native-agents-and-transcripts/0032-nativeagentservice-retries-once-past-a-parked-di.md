# `NativeAgentService > retries once past a parked dispatch the provider can now vouch for` (`apps/backend/src/core/native-agent-service-dispatch.test.ts:767`)

- **ID:** 0032
- **Status:** open
- **Date observed:** 2026-08-25
- **Original command:**
  `bun --cwd apps/backend test src/core/http-bridge-provider.test.ts`; the
  package script expanded this to
  `bun test --preload ../../tests/setup-node.ts src tests --parallel src/core/http-bridge-provider.test.ts`.
- **Worker configuration:** the backend package ran 18 Bun workers over `src`
  and `tests`; the trailing file argument did not narrow the package script.
- **Failure:** the case was reported failed after 32.48 ms. The direct command
  output exceeded the capture budget before Bun's assertion detail, so no
  failure message was retained.
- **Suite counts:** 2,057 total, 2,048 passed, 9 failed, 7,525 `expect()` calls
  across 80 files in 10.66 s. Eight sibling failures were in the standalone
  backend process suite and match existing environment/process-lifecycle
  entries in this file.
- **Isolated rerun:**
  `bun test src/core/native-agent-service-dispatch.test.ts --preload ../../tests/setup-node.ts --test-name-pattern 'retries once past a parked dispatch'`
  from `apps/backend` -> 1 passed, 62 filtered out, 4 `expect()` calls in 28 ms;
  the target passed in 12.65 ms.
- **Attribution:** the change in flight adds Pi bridge composer rehydration and
  makes the HTTP bridge provider's explicit Pi catalogue refresh call the Pi
  bridge. This case uses a Cursor provider stub directly through
  `NativeAgentService`; it never constructs `HttpBridgeProvider` and does not
  load the Pi bridge.
- **Hypothesis:** the evidence establishes an aggregate-only failure but not
  its mechanism because the assertion detail was truncated. A recurrence needs
  the complete assertion and surrounding worker output before changing the
  dispatch reconciliation logic or its expectations.
