# `NativeAgentService > retries once past a parked dispatch the provider can now vouch for` (`apps/backend/src/core/native-agent-service-dispatch.test.ts:767`)

- **ID:** 0032
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:**
  `bun --cwd apps/backend test src/core/http-bridge/provider.test.ts`; the
  package script expanded this to
  `bun test --preload ../../tests/setup-node.ts src tests --parallel src/core/http-bridge/provider.test.ts`.
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

## Resolution (2026-11-10)

- **Root cause:** a product race between the dispatch path and the background
  settle of a parked dispatch. When the first dispatch's acknowledgement is
  lost, `attemptDispatch` (then in `native-agent-service.ts`, now `apps/backend/src/core/native-agent-prompt-dispatch.ts`)
  parks it and fires `refreshProjectionState` without awaiting it. That
  projection read calls `scheduleAmbiguousDispatchSettle`, which asks the
  provider about the parked id in the background. The next prompt is refused
  with `PendingNativeAgentDispatchError`, and its own `settleAmbiguousDispatch`
  re-reads the session first. If the background settle confirmed the parked
  record after the refusal but before that re-read, the re-read found no
  matching `pendingDispatch`, the settle answered `undefined`, and the prompt
  was rejected with "An earlier message is still awaiting confirmation" even
  though nothing was parked any more. Normally the background read runs
  before the test marks the turn dispatched (it answers `unknown` and
  changes nothing); under load it can run after, which opens the window. A
  user whose tab refreshed at that moment would have had a prompt refused
  for no reason.
- **Fix:** in the refused-by-parked-dispatch branch, `attemptDispatch` also
  takes its single bounded retry when the parked record it was refused by is
  no longer pending (`parkedDispatchReleased`). A failed storage read keeps the
  block, and the retry still runs under the dispatch fence, so a newer parked
  dispatch still refuses the prompt.
- **Reproduced:** yes — a temporary `await Bun.sleep(100)` before the settle in
  the refused branch (the side that has to lose) plus a 50 ms delay in the
  test stub's second `dispatchStatus` call (the background settle, so it reads
  after the flip). Tracing showed the background call answering
  `dispatched=true` after the refusal, and the test failed with
  `outcome: "rejected"` and the parked-conflict message instead of
  `{ outcome: "accepted", requestId: "second" }`. With the fix and the same two
  delays it passed. The delays and tracing were removed.
- **Stress:** `mise run test:logged -- --name n0032-stress -- bun scripts/test-under-contention.ts -- bash -c 'cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/native-agent-service-dispatch.test.ts -t "parked dispatch" --rerun-each=30'`
  passed (macOS: burners unpinned). The dispatch, base, prompt-queue
  dispatcher and reconciliation suites passed with `--parallel=2`, and the
  backend typecheck passed.
